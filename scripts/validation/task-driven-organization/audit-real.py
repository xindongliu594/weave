"""Independent read/download audit. Never changes employee files or production data."""
import hashlib, io, json, pathlib, urllib.parse, urllib.request, zipfile
import xml.etree.ElementTree as ET
ROOT=pathlib.Path('/home/jj/.local/share/weiwu/validation/task-driven-organization-20261018/real-20261019')
BASE='http://127.0.0.1:4310/api/'
s=json.loads((ROOT/'state.json').read_text())
def get(route):
    with urllib.request.urlopen(BASE+route,timeout=30) as r:return json.load(r)
def sha(b):return hashlib.sha256(b).hexdigest()
def save(name,value):
    with (ROOT/name).open('x') as f:json.dump(value,f,ensure_ascii=False,indent=2)
def events(run,kind):return [e for e in run['events'] if e['type']==kind]
parent=get('runs/'+s['runId']+'/export');child=get('runs/'+s['contextParentRunId']+'/export')
final=get('runs/'+s['resumedRunId']+'/export');runs=[parent,child,final]
current=get('runs/'+s['resumedRunId']+'?limit=1')
assert current['status']=='completed',(current['status'],current.get('error'))
before=json.loads((ROOT/'before-restart.json').read_text());after=json.loads((ROOT/'after-restart.json').read_text())
checks=[]
def check(name,passed):
    checks.append({'name':name,'passed':bool(passed)})
    assert passed,name
check('original and both recovered archives intact',all(r['integrity']=='ok' for r in runs))
check('restart preserved all settled usage and six unknown reservations',before['usage']==after['usage'] and before['costs']['calls']==after['costs']['calls'])
check('original approved DAG and requirements preserved',parent['snapshot']['tasks']==child['snapshot']['approvedTasks'] and parent['snapshot']['requirement']==child['snapshot']['requirement'])
for key in ['policy','agents','orchestration','deliveryCriteria','goalContract']:
    check(key+' unchanged across restart',parent['snapshot'][key]==child['snapshot'][key])
check('author completed checkpoint restored',child['snapshot']['completedCheckpoints']==['write-docx'])
check('author never redispatched or reaccepted',not [e for e in events(child,'model/wire-request')+events(child,'handoff/accepted') if e.get('taskId',e['data'].get('taskId'))=='write-docx'])
check('all prior model calls and spend carried',child['snapshot']['budgetHistory']['calls']==len(events(parent,'model/wire-request')) and abs(child['snapshot']['executionBudget']-(.26-sum(u['cost'] for u in before['usage'] if u.get('projectId')==s['projectId'])))<1e-9)
check('recovery happened before any new model request',events(child,'recovery/restored')[0]['seq']<events(child,'model/wire-request')[0]['seq'])
accepted=[e for r in runs for e in events(r,'handoff/accepted')]
check('exactly three official independent handoffs',[e['data']['taskId'] for e in accepted]==['write-docx','qa-verify','manager-accept'])
restored=events(child,'recovery/restored')[0]['data']['files']
author=accepted[0]['data']['outputs'][0]
check('original DOCX version restored',any(f['path']==author['path'] and f['sha256']==author['sha256'] for f in restored))
check('both completed nodes restored in final continuation',set(final['snapshot']['completedCheckpoints'])=={'write-docx','qa-verify'})
check('final continuation never redispatches completed nodes',all(e['data'].get('taskId')=='manager-accept' for e in events(final,'model/wire-request')))
for key in ['requirement','agents','orchestration','deliveryCriteria']:
    check(key+' preserved after resource-only revision',child['snapshot'][key]==final['snapshot'][key])
check('resource-only continuation remains within original authorization',final['snapshot']['policy']['maxBudget']==.26 and final['snapshot']['policy']['maxModelCalls']==48 and final['snapshot']['policy']['contextBytes']==117000)
check('final restored input versions match accepted files',all(any(f['path']==o['path'] and f['sha256']==o['sha256'] for f in events(final,'recovery/restored')[0]['data']['files']) for a in accepted[:2] for o in a['data']['outputs']))
verified=events(final,'delivery/verified')
check('every delivery requirement has matching host evidence',len(verified)==1 and len(verified[0]['data']['criteria'])==len(final['snapshot']['deliveryCriteria']) and all(c['status']=='passed' for c in verified[0]['data']['criteria']))
check('no unknown or pending operation at interruption or completion',not before['run']['recovery']['unknownOperations'] and not current['recovery']['unknownOperations'] and not [o for o in before['operations'] if o['status'] in ['queued','claimed','started']])
downloads={};out=ROOT/'employee-deliverables';out.mkdir(exist_ok=False)
files=get('runs/'+s['resumedRunId']+'/artifacts')
check('only approved delivery files',{f['path'] for f in files}=={'report.docx','qa.json','acceptance.json'})
for f in files:
    with urllib.request.urlopen(BASE+'runs/'+s['resumedRunId']+'/artifact?path='+urllib.parse.quote(f['path']),timeout=30) as r:b=r.read()
    check('download SHA matches '+f['path'],sha(b)==f['sha256'])
    (out/f['path']).write_bytes(b);downloads[f['path']]=b
check('final DOCX is the original accepted bytes',sha(downloads['report.docx'])==author['sha256'])
with zipfile.ZipFile(io.BytesIO(downloads['report.docx'])) as z:
    check('DOCX ZIP complete',z.testzip() is None)
    root=ET.fromstring(z.read('word/document.xml'));ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
    text='\n'.join(''.join(p.itertext()) for p in root.findall('.//w:p',ns))
    rows=[[ ''.join(c.itertext()) for c in row.findall('w:tc',ns)] for row in root.findall('.//w:tr',ns)]
    check('three original facts in actual Word table',all([k,v] in rows for k,v in [('首页','通过'),('登录','通过'),('备份','失败')]))
    check('fictional-data and no-real-inspection disclosure','虚构测试资料' in text and '未访问' in text and '真实巡检' in text)
    check('correct 3/2/1 totals',all(x in text for x in ['总计：3项','通过：2项','失败：1项']))
for name in ['qa.json','acceptance.json']:
    value=json.loads(downloads[name]);check(name+' employee verdict pass',value['verdict']=='pass')
usage=get('usage');costs=get('costs');new=[u for u in usage if u['id'] not in s['baselineUsageIds']]
project=[u for u in new if u.get('projectId')==s['projectId']]
check('no added unknown fees',{c['id']:c['amount'] for c in costs['calls']}=={c['id']:c['amount'] for c in s['baselineUnknown']})
check('execution within .26 and 48 requests',sum(u['cost'] for u in project)<=.26 and len(project)<=48)
dept=next(d for d in get('departments') if d['id']==s['baselineDepartment']['id'])
check('source department employees unchanged',dept['version']==s['baselineDepartment']['version'] and dept['agents']==s['baselineDepartment']['agents'])
lineage=get('runs/'+s['resumedRunId']+'/lineage-evidence')
save('parent-export.json',parent);save('child-export.json',child);save('final-export.json',final);save('lineage.json',lineage)
result={'passed':True,'projectId':s['projectId'],'parentRunId':s['runId'],'restartRunId':s['contextParentRunId'],'resumedRunId':s['resumedRunId'],'checks':checks,'files':files,'wordTableRows':rows,'wordText':text,'newUsage':new,'phaseCost':sum(u['cost'] for u in new),'projectCost':sum(u['cost'] for u in project),'projectCalls':len(project),'inputTokens':sum(u['inputTokens'] for u in project),'outputTokens':sum(u['outputTokens'] for u in project),'cumulativeOccupied':sum(u['cost'] for u in usage)+sum(c['amount'] for c in costs['calls']),'unknownCount':len(costs['calls']),'originalDepartmentVersion':dept['version'],'employeeDeliverablesEditedByCodex':False,'limitation':'Content/OOXML/hash and genuine employee checks verified; exact desktop Word pagination not verified. Controlled pre-dispatch pause, then graceful service shutdown, not arbitrary mid-request crash.'}
save('real-audit.json',result);print(json.dumps({k:v for k,v in result.items() if k not in ['wordText','wordTableRows','newUsage']},ensure_ascii=False))
