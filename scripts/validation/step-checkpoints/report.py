"""Read-only bounded public evidence; no credentials or raw model conversations."""
import json,pathlib,sys
from acceptance import Acceptance

root=pathlib.Path('/home/jj/.local/share/weiwu/validation/step-acceptance-20261020')
app=Acceptance(root)
child_id='58de522b-7015-4d8b-98dd-6e3d7557bfc1'
parent=app.api('/runs/'+app.s['runId']+'/export');child=app.api('/runs/'+child_id+'/export')
assert child['snapshot']['resumedFrom']==parent['id']
assert child['snapshot']['projectId']==app.s['projectId']
app.s['resumedRunId']=child_id;app.save()  # Harness bookkeeping only, never product data.
usage=[r for r in app.api('/usage') if r['id'] not in app.s['baselineUsageIds']]
calls=[{k:r.get(k) for k in ['id','runId','sessionId','taskId','requestId','inputTokens','outputTokens','durationMs','cost','purpose']} for r in usage]
planning=[r for r in usage if r.get('runId') not in [parent['id'],child_id]]
assert len(planning)==4
def describe(run):
    operations=app.api('/runs/'+run['id']+'/local-operations')
    commands=[{'id':o['id'],'status':o['status'],'command':o['payload']['arguments'].get('command'),
        'exitCode':(o.get('result') or {}).get('exitCode'),'output':(o.get('result') or {}).get('output')}
        for o in operations if o['payload']['name']=='terminal_test']
    return {'id':run['id'],'status':run['events'][-1]['data'].get('status'),
        'outcome':next(e['data'] for e in reversed(run['events']) if e['type']=='run/finished'),
        'wireRequests':sum(e['type']=='model/wire-request' for e in run['events']),
        'completedTaskIds':[e['data']['taskId'] for e in run['events'] if e['type']=='handoff/accepted'],
        'restored':next((e['data'] for e in run['events'] if e['type']=='recovery/restored'),None),
        'artifacts':app.api('/runs/'+run['id']+'/artifacts'),'commands':commands}
p,c=describe(parent),describe(child)
assert p['artifacts']==c['artifacts']
assert c['restored']['completed']==['develop']
assert not any(e['type']=='model/wire-request' and e['data'].get('taskId')=='develop' for e in child['events'])
restoration=json.loads((root/'controls-v3/after-remove.json').read_text())
assert all(restoration[k] for k in ['restored','usageUnchanged','unknownFeesUnchanged'])
deployment=json.loads((root.parent/'mvp-hardening-snapshot-20261020/deployment.json').read_text())
report={'passed':False,'reason':'QA handoff/manager acceptance and eligible test reuse remain unverified',
    'projectId':app.s['projectId'],'conversationId':app.s['conversationId'],
    'limits':{'planning':.05,'execution':.13,'phase':.18,'cumulative':3.41,'planningCalls':4,'executionCalls':32},
    'money':app.money(),'planningCalls':len(planning),'planningCost':round(sum(r['cost'] for r in planning),9),
    'modelCalls':len(usage),'calls':calls,'parent':p,'child':c,
    'recoveryConditions':app.api('/runs/'+child_id+'/recovery-check'),
    'filesMatch':True,'developerNotRerun':True,'controlledBoundaryReached':(root/'boundary.json').exists(),
    'originalControlsRestored':True,'sevenUnknownHoldsUnchanged':True,
    'deployment':{k:deployment[k] for k in ['passed','release','backup','packageSha256','stoppedAudit']}}
print(json.dumps(report,ensure_ascii=False,indent=2))
