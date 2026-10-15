"""One explicitly authorized recovery via the existing resource-proposal/retry APIs."""
import json,pathlib,sys,urllib.request,urllib.error
ROOT=pathlib.Path('/home/jj/.local/share/weiwu/validation/experience-methods-20261015')
RUN='10d6906e-8b7b-4131-9f99-fa29551f72a8'
PROJECT='cf082432-c6e7-42d2-8068-0ef9bbdd7dee'
def api(path,body=None):
    req=urllib.request.Request('http://127.0.0.1:4310/api'+path,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=200) as response:return json.load(response)
def save(name,value): (ROOT/name).write_text(json.dumps(value,ensure_ascii=False,indent=2))
mode=sys.argv[1]
assert mode in ['propose','resume','status']
if mode=='status':
    child=json.loads((ROOT/'continuation-start.json').read_text())['id']
    run=api('/runs/'+child+'/export');save('continuation-run.json',run)
    states=api('/runs');row=next(r for r in states if r['id']==child)
    team=next((e['data'] for e in reversed(run['events']) if e['type']=='team/snapshot'),{})
    print(json.dumps({'run':row,'tasks':[{'id':t['id'],'status':t['status']} for t in team.get('tasks',[]) ]},ensure_ascii=False));sys.exit()
source=api('/runs/'+RUN+'/export')
assert source['projectId']==PROJECT and source['status']=='failed' and source['integrity']=='ok'
assert source['snapshot']['policy']['maxBudget']==.15
old=json.loads((ROOT/'before.json').read_text())['holds'];costs=api('/costs');usage=api('/usage')
assert all(h in costs['calls'] for h in old)
assert not any(r['status'] in ['running','queued'] for r in api('/runs'))
readiness=api('/projects/'+PROJECT+'/cost-readiness')
occupied=sum(u['cost'] for u in usage)+sum(h['amount'] for h in costs['calls'])
worst=occupied+.4-readiness['recordedCost']-readiness['reserved']
assert worst<=2.96+1e-9 and worst-2.0708184<=.90+1e-9
if mode=='propose':
    body={'modelId':'c8a4e6ad-1aaf-43a4-8ba1-d0a6cce59051','maxBudget':.4,'maxPlanningCost':.006,'retainUncertainCosts':True,'maxModelCalls':32,'maxTaskModelCalls':16,'taskContinuationLimits':{'qa-check':6,'accept':6}}
    with (ROOT/'continuation-propose.lock').open('x') as lock:lock.write(json.dumps(body))
    save('continuation-before.json',{'occupied':occupied,'worst':worst,'readiness':readiness,'holds':costs['calls'],'request':body})
    try:result=api('/runs/'+RUN+'/resource-proposal',body)
    except urllib.error.HTTPError as e:
        save('continuation-proposal-error.json',{'status':e.code,'body':e.read().decode()});raise
    save('continuation-proposal.json',result)
    print(json.dumps(result,ensure_ascii=False));sys.exit()
preview=json.loads((ROOT/'continuation-proposal.json').read_text());p=preview['proposal']
assert preview['sourceRunId']==RUN and preview['completedTaskIds']==['develop']
assert .15<=p['maxBudget']<=.4 and p.get('maxModelCalls',32)<=32
assert preview['taskContinuationLimits']=={'qa-check':6,'accept':6}
assert all(v<=16 for v in p['taskCallLimits'].values())
with (ROOT/'continuation-resume.lock').open('x') as lock:lock.write(preview['previewId'])
result=api('/runs/'+RUN+'/retry',{'resume':True,'retainUncertainCosts':True,'budgetPreviewId':preview['previewId'],'confirmation':'APPROVE_RESOURCES_AND_RESUME'})
save('continuation-start.json',result);print(json.dumps(result))
