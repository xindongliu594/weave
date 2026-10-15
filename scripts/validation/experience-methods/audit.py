"""Export compact real evidence and measurements; never infer acceptance from reads."""
import collections,hashlib,json,pathlib,urllib.request
ROOT=pathlib.Path('/home/jj/.local/share/weiwu/validation/experience-methods-20261015')
def get(path):return json.load(urllib.request.urlopen('http://127.0.0.1:4310/api'+path))
def save(name,value):(ROOT/name).write_text(json.dumps(value,ensure_ascii=False,indent=2))
usage=get('/usage');costs=get('/costs');prior=json.loads((ROOT/'before.json').read_text())
assert all(h in costs['calls'] for h in prior['holds'])
results=[]
for filename in ['reuse-run.json','continuation-run.json']:
    run=json.loads((ROOT/filename).read_text());events=run['events'];bills=[e for e in events if e['type']=='billing/usage']
    by_task={}
    for e in bills:
        b=e['data'];v=by_task.setdefault(b.get('taskId','unattributed'),{'calls':0,'inputTokens':0,'outputTokens':0,'cost':0,'modelDurationMs':0})
        for key in ['inputTokens','outputTokens','cost']:v[key]+=b[key]
        v['calls']+=1;v['modelDurationMs']+=b.get('durationMs',0)
    with urllib.request.urlopen('http://127.0.0.1:4310/api/runs/'+run['id']+'/artifact?path=refund-cases.md') as response:artifact=response.read()
    assert hashlib.sha256(artifact).hexdigest()=='6b14ce351d6cce8914ba4df3b7e7d9dd1942292771536fb9ac462cf4efd1ec40'
    (ROOT/'refund-cases.md').write_bytes(artifact)
    selected=[e for e in events if e['type'] in ['capability/adopted','knowledge/citation','recovery/restored','handoff/accepted','handoff/closure-started','run/finished','billing/usage','context/summary-skipped-for-handoff']]
    save('events-'+run['id']+'.json',selected)
    results.append({'runId':run['id'],'status':run['status'],'integrity':run['integrity'],'startedAt':run['createdAt'],'endedAt':events[-1]['at'],'modelCalls':len(bills),'byTask':by_task,'completedCheckpoints':run['snapshot'].get('completedCheckpoints',[]),'artifact':{'path':'refund-cases.md','bytes':len(artifact),'sha256':hashlib.sha256(artifact).hexdigest()},'newMethodAdoptions':[{'seq':e['seq'],**e['data']} for e in events if e['type']=='capability/adopted' and e['data'].get('source',{}).get('documentId','').startswith('reuse-')],'failure':events[-1]['data']})
published=get('/knowledge/documents');doc=next(d for d in published if d['id']=='reuse-7fc6493f431e89a7b2e2c0de541d424c02cff6c9')
versions=get('/knowledge/documents/'+doc['id']+'/versions')
assert len(versions)==1 and doc['version']==1 and not doc.get('source',{}).get('skillName')
save('published.json',doc)
purposes=['经验文档提炼 2026-10-15','经验跨任务验收资源规划 2026-10-15']
own=[u for u in usage if any(str(u.get('purpose','')).startswith(p) for p in purposes) or u.get('id')=='4078775d-c917-49a2-ba75-3c20b0cbc8a3']
occupied=sum(u['cost'] for u in usage)+sum(c['amount'] for c in costs['calls'])
save('audit.json',{'runs':results,'receipts':own,'oldHoldCount':len(prior['holds']),'oldHoldsPreserved':True,'occupied':occupied,'phaseOccupied':occupied-2.0708184,'published':{'id':doc['id'],'version':doc['version'],'sha256':doc['sha256'],'versionCount':len(versions),'ordinaryKnowledge':True},'fullAcceptance':False,'efficiencyImprovement':None,'limitation':'No matched baseline; QA not sealed and manager not executed. Model self-reported adoption alone is not successful work.'})
print(json.dumps({'runs':[{'id':r['runId'],'calls':r['modelCalls'],'cost':r['failure'].get('usageCost'),'newMethodAdoptions':len(r['newMethodAdoptions'])} for r in results],'occupied':occupied,'oldHoldsPreserved':True},ensure_ascii=False))
