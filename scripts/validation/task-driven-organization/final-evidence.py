"""Collect the final bounded evidence after all paid work; read-only public APIs."""
import json,pathlib,sys,urllib.request
from decimal import Decimal
root=pathlib.Path('/home/jj/.local/share/weiwu/validation/task-driven-organization-20261018/real-20261019')
s=json.loads((root/'state.json').read_text())
def get(path):
 with urllib.request.urlopen('http://127.0.0.1:4310/api/'+path,timeout=30) as r:return json.load(r)
def save(name,value):
 with (root/name).open('x') as f:json.dump(value,f,ensure_ascii=False,indent=2)
if sys.argv[1:]==['--post-deploy']:
 lineage=get('runs/'+s['resumedRunId']+'/lineage-evidence')
 assert lineage['status']=='verified' and all(r['status']=='passed' for r in lineage['acceptance']['deliveryCriteria'])
 result={'health':get('health'),'lineageStatus':lineage['status'],'criteria':lineage['acceptance']['deliveryCriteria'],
  'usageCount':len(get('usage')),'activeRuns':[r['id'] for r in get('runs') if r['status'] in ['running','queued']]}
 assert result['usageCount']==len(s['baselineUsageIds'])+25 and result['activeRuns']==[]
 save('post-deploy.json',result);print(json.dumps({'healthy':result['health']['database']=='connected','lineage':result['lineageStatus'],'criteriaPassed':len(result['criteria']),'usageCount':result['usageCount'],'activeRuns':[]},ensure_ascii=False));sys.exit(0)
lineage=get('runs/'+s['resumedRunId']+'/lineage-evidence')
assert lineage['status']=='verified' and all(r['status']=='passed' for r in lineage['acceptance']['deliveryCriteria'])
save('final-lineage.json',lineage)
usage=get('usage');costs=get('costs');new=[u for u in usage if u['id'] not in s['baselineUsageIds']]
assert {c['id']:c['amount'] for c in costs['calls']}=={c['id']:c['amount'] for c in s['baselineUnknown']}
assert not [r for r in get('runs') if r['status'] in ['running','queued']]
plans=[]
for label,request in s['requests'].items():
 if not (label.startswith('plan-') or label.startswith('correct-word')):continue
 r=request.get('result',{});preview=r.get('preview')
 plans.append({'label':label,'status':request['status'],'reply':r.get('reply'),'draftIssue':r.get('draftIssue'),
  'previewId':preview.get('previewId') if preview else None,'candidate':preview.get('candidate') if preview else None})
save('planning-results.json',plans)
toolEvidence=[]
for name in ['parent-export.json','child-export.json','final-export.json']:
 r=json.loads((root/name).read_text())
 for e in r['events']:
  if e['type']=='tool/result' and e['data'].get('name') in ['plugin__office__docx_create','plugin__office__docx_read']:
   toolEvidence.append({'runId':r['id'],'seq':e['seq'],'agentId':e.get('agentId'),'sessionId':e.get('sessionId'),'tool':e['data']['name'],'isError':e['data'].get('result',{}).get('isError',False)})
assert any(t['tool']=='plugin__office__docx_create' and not t['isError'] for t in toolEvidence)
assert all(any(t['runId']==r and t['tool']=='plugin__office__docx_read' and not t['isError'] for t in toolEvidence) for r in [s['runId'],s['contextParentRunId'],s['resumedRunId']])
save('native-tool-evidence.json',toolEvidence)
phase=sum(Decimal(str(u['cost'])) for u in new)
occupied=sum(Decimal(str(u['cost'])) for u in usage)+sum(Decimal(str(c['amount'])) for c in costs['calls'])
assert phase<=Decimal('.34') and occupied<=Decimal('3.41')
summary={'projectId':s['projectId'],'runId':s['resumedRunId'],'phaseSpent':float(phase),'cumulativeOccupied':float(occupied),'usageCount':len(new),
 'inputTokens':sum(u['inputTokens'] for u in new),'outputTokens':sum(u['outputTokens'] for u in new),'unknownCount':len(costs['calls']),
 'planningSamples':3,'firstAttemptValidCandidates':0,'eventuallyValidScenarios':1,'failedScenarios':['summary','temperature'],
 'recoveredUiCriteriaPassed':len(lineage['acceptance']['deliveryCriteria']),'health':get('health'),'newUsage':new,
 'planningGuardRestored':json.loads((root/'planning-guard-restored.json').read_text()),'planningQuote':json.loads((root/'planning-dispatch-quote.json').read_text())}
save('final-summary.json',summary)
print(json.dumps({k:v for k,v in summary.items() if k not in ['newUsage','health']},ensure_ascii=False))
