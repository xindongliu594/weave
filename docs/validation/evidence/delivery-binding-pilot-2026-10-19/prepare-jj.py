import pathlib,subprocess,os,json,hashlib,urllib.request,datetime
root=pathlib.Path('/home/jj/.local/share/weiwu')
base=root/'validation/delivery-binding-pilot-20261019-a05f034';repo=base/'source'
repo.mkdir(exist_ok=False)
subprocess.run(['tar','-xzf',str(base/'source-a05f034.tar.gz'),'-C',str(repo)],check=True)
files=['cases.mjs','worker.mjs','broker.mjs','launch-approved.py','delivery-binding.test.mjs']
for name in files:(repo/'scripts/validation/orchestration-planning-pilot'/name).write_bytes((base/name).read_bytes())
live=root/'releases/weiwu-task-organization-20261018'
for rel in ['node_modules','services/agent-runtime/node_modules']:(repo/rel).symlink_to(live/rel,target_is_directory=True)
node=root/'runtime/node-v24.19.0-linux-x64/bin/node'
env={'PATH':str(node.parent)+':/usr/bin:/bin','HOME':str(base),'LANG':'C.UTF-8'}
checks={
 'tests':[str(node),'--test',*[str(repo/'scripts/validation/orchestration-planning-pilot'/name) for name in ['feedback.test.mjs','delivery-binding.test.mjs','limits.test.mjs','lifecycle.test.mjs']]],
 'dry-run':[str(node),str(repo/'scripts/validation/orchestration-planning-pilot/broker.mjs'),'dry-run',str(repo),str(base/'dry-run'),'delivery-binding'],
}
report={'sourceCommit':'a05f034','modelCalls':0,'productionWrites':0,'checks':{},'sha256':{f:hashlib.sha256((repo/'scripts/validation/orchestration-planning-pilot'/f).read_bytes()).hexdigest() for f in files}}
for name,args in checks.items():
 with (base/(name+'.txt')).open('w') as output:r=subprocess.run(args,cwd=repo,env=env,stdout=output,stderr=subprocess.STDOUT,timeout=180)
 report['checks'][name]=r.returncode
 (base/'prepare-result.json').write_text(json.dumps(report,indent=2))
 print(json.dumps({'check':name,'exitCode':r.returncode}),flush=True)
 if r.returncode:raise SystemExit(r.returncode)
def api(route):
 with urllib.request.urlopen('http://127.0.0.1:4310/api/'+route,timeout=30) as response:return json.load(response)
usage=api('usage');costs=api('costs')
holds=sorted([{'id':c['id'],'status':c['status'],'amount':c['amount']} for c in costs['calls']],key=lambda c:c['id'])
prior=json.loads((repo/'docs/validation/evidence/orchestration-feedback-pilot-2026-10-19/real/broker-result.json').read_text())['after']
assert holds==prior['holds'],'Unknown receipt baseline changed'
assert not [r for r in api('runs') if r['status'] in ['running','queued']]
model=next(m for m in api('models') if m['id']=='c8a4e6ad-1aaf-43a4-8ba1-d0a6cce59051' and m['status']=='available')
public={k:model[k] for k in ['id','name','model','inputRate','outputRate','protocol','thinkingMode','capabilities'] if k in model}
baseline={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'spent':sum(u['cost'] for u in usage),'reserved':sum(h['amount'] for h in holds),'holds':holds,'model':public,'activeRuns':0}
assert baseline['spent']+baseline['reserved']+.02<=3.41
(base/'baseline.json').write_text(json.dumps(baseline,indent=2))
quote_script="""import {readFileSync,writeFileSync} from 'node:fs';
import {budgetedRequestEstimate} from './source/apps/api/src/cost-control.ts';
const base=JSON.parse(readFileSync('./baseline.json','utf8')),run=JSON.parse(readFileSync('./dry-run/broker-result.json','utf8'));
const body=run.requests[0].request;
const estimate=budgetedRequestEstimate(base.model,body.messages,body.max_tokens,body.response_format?{response_format:body.response_format}:{});
if(estimate.reservation>.02)throw Error('Quote exceeds proposed ceiling');
writeFileSync('./quote.json',JSON.stringify({reservation:estimate.reservation,maxOutputTokens:body.max_tokens,requestBytes:Buffer.byteLength(JSON.stringify(body)),messages:body.messages.length,model:base.model.model,inputRate:base.model.inputRate,outputRate:base.model.outputRate},null,2));
"""
(base/'quote.mjs').write_text(quote_script)
subprocess.run([str(node),'--import',str(repo/'node_modules/tsx/dist/loader.mjs'),str(base/'quote.mjs')],cwd=base,env=env,timeout=60,check=True)
report['baseline']={k:baseline[k] for k in ['checkedAt','spent','reserved','activeRuns']}
report['oldUnknowns']=len(holds);report['quote']=json.loads((base/'quote.json').read_text())
(base/'prepare-result.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report),flush=True)
