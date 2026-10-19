"""Read actual product records and download immutable employee outputs, without editing them."""
import collections, hashlib, json, pathlib, urllib.parse, urllib.request
from decimal import Decimal
import driver as d

p=d.ROOT; out=p/'evidence'; out.mkdir(exist_ok=True)
def write(name,value):
    with (out/name).open('x',encoding='utf-8') as f:json.dump(value,f,ensure_ascii=False,indent=2)
def sha(data):return hashlib.sha256(data).hexdigest()
s=d.s; first=d.api('/runs/'+s['runId']+'/export'); last=d.api('/runs/'+s['resumedRunId']+'/export')
status=d.api('/runs/'+s['resumedRunId']+'?limit=1'); money=d.money()
assert status['status']=='completed' and status.get('error') is None
assert first['integrity']==last['integrity']=='ok'
assert last['resumedFrom']==s['runId'] and last['completedCheckpoints']==['develop']
assert first['snapshot']['tasks']==last['snapshot']['approvedTasks']
assert first['policy']==last['policy']==s['policy']
assert last['costCarryover']['recordedCost']>0
accepted=[e['data'] for r in [first,last] for e in r['events'] if e['type']=='handoff/accepted']
assert [a['taskId'] for a in accepted]==['develop','verify','accept']
assert all(a['employeeReport']['acceptanceResults'] and all(c['status']=='passed' for c in a['employeeReport']['acceptanceResults']) for a in accepted)
restored=next(e['data'] for e in last['events'] if e['type']=='recovery/restored')
assert restored['completed']==['develop']
initial={f['path']:f['sha256'] for f in accepted[0]['outputs']}
assert {f['path']:f['sha256'] for f in restored['files']}==initial
wires=[e['data'] for e in last['events'] if e['type']=='model/wire-request']
assert all(e['taskId']!='develop' for e in wires)
observed=[e for e in last['events'] if e['type']=='handoff/command-observed']
assert len(observed)==2 and all(e['data']['command']=='node --test cli.test.mjs' and e['data']['exitCode']==0 for e in observed)
assert all(e['data']['evidence']['nodeTests']['pass']==13 and e['data']['evidence']['nodeTests']['fail']==0 for e in observed)
artifacts=d.api('/runs/'+s['resumedRunId']+'/artifacts')
assert {a['path'] for a in artifacts}=={'cli.mjs','README.md','cli.test.mjs'}
files=out/'employee-delivery';files.mkdir(exist_ok=True)
for a in artifacts:
    with urllib.request.urlopen(d.BASE+'/runs/'+s['resumedRunId']+'/artifact?path='+urllib.parse.quote(a['path']),timeout=20) as f:data=f.read()
    assert sha(data)==a['sha256'] and len(data)==a['size']
    if a['path'] in initial:assert a['sha256']==initial[a['path']]
    with (files/a['path']).open('xb') as f:f.write(data)
release=pathlib.Path('/home/jj/.local/share/weiwu/releases/weiwu-task-organization-20261018')
controls={}
for file,record in [('scripts/local-api.ts','control-installed.json'),('apps/api/src/cost-control.ts','planning-guard-installed.json')]:
    expected=json.loads((p/record).read_text())['originalSha256'];actual=sha((release/file).read_bytes());assert actual==expected
    controls[file]={'restored':True,'sha256':actual}
usage=money['newUsage'];counts=dict(collections.Counter(u['taskId'] or 'planning' for u in usage))
assert counts=={'planning':2,'develop':5,'verify':10,'accept':3}
costs={key:float(sum(Decimal(str(u['cost'])) for u in usage if (u['taskId'] or 'planning')==key)) for key in counts}
assert next(x for x in d.api('/departments') if x['id']==d.DEPT)['version']==s['baselineDepartment']['version']
assert not [a for a in d.api('/approvals?runId='+s['resumedRunId']) if a['status']=='pending']
write('audit.json',{'passed':True,'projectId':s['projectId'],'sourceRunId':s['runId'],'completedRunId':s['resumedRunId'],'previewId':s['plan']['preview']['previewId'],'status':status['status'],'counts':counts,'costs':costs,'phaseSpent':money['phaseSpent'],'cumulativeOccupied':money['cumulativeOccupied'],'oldUnknownCount':len(s['baselineUnknown']),'artifacts':artifacts,'recovery':restored,'costCarryover':last['costCarryover'],'sourceRestoration':controls,'limits':{'phase':.28,'planning':.03,'project':.25,'cumulative':3.41},'limitations':['First plan lacked formal independent review; second model turn corrected it.','QA submitted invalid report.risks, then reread/researched and repeated unchanged tests before successful correction.','Controlled interruption occurred before an external request, not during an unknown in-flight operation.','No new-template execution, knowledge or backup test in this narrow acceptance.']})
write('handoffs.json',accepted);write('usage.json',usage);write('unknown-holds.json',s['baselineUnknown'])
write('model-plan.json',s['plan']);write('rejected-plan.json',s['firstPlan'])
write('commands.json',observed);write('approvals.json',d.api('/approvals?runId='+s['runId'])+d.api('/approvals?runId='+s['resumedRunId']))
write('recovery-check.json',s['recoveryCheck'])
for r,name in [(first,'original'),(last,'resumed')]:
    # Full archive stays private on JJ; portable evidence excludes large duplicated model contexts.
    with (p/(name+'-full-export.json')).open('x') as f:json.dump(r,f,ensure_ascii=False)
    write(name+'-execution.json',{'snapshot':r['snapshot'],'integrity':r['integrity'],'events':[e for e in r['events'] if e['type'] in ['recovery/restored','handoff/accepted','handoff/command-observed','handoff/inputs-bound','goal/anchored','goal/node-accepted','run/finished','billing/usage','billing/provider-response','approval/requested','approval/decided','local/operation-queued','local/operation-finished']]})
tests=[e['data']['result']['value'] for e in last['events'] if e['type']=='tool/result' and e['data']['name']=='terminal_test' and not e['data']['result'].get('isError')]
write('test-results.json',tests)
errors=[e for e in last['events'] if e['type']=='tool/result' and e['data']['result'].get('isError')];write('observed-errors.json',errors)
print(json.dumps({'passed':True,'status':status['status'],'counts':counts,'costs':costs,'phaseSpent':money['phaseSpent'],'cumulativeOccupied':money['cumulativeOccupied'],'evidence':str(out)},ensure_ascii=False))
