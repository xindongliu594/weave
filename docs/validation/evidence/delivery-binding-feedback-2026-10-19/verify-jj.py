import pathlib,subprocess,os,json,hashlib
base=pathlib.Path('/home/jj/.local/share/weiwu/validation/delivery-binding-20261019-0f55e13');repo=base/'source'
repo.mkdir(exist_ok=False)
subprocess.run(['tar','-xzf',str(base/'source-0f55e13.tar.gz'),'-C',str(repo)],check=True)
files=['packages/contracts/orchestration.ts','packages/contracts/index.ts','apps/api/src/organization-routing.ts','apps/api/src/organization-task-planning.ts','tests/delivery-binding-feedback.test.ts','tests/orchestration-pattern-integration.test.ts']
for rel in files:(repo/rel).write_bytes((base/pathlib.Path(rel).name).read_bytes())
live=pathlib.Path('/home/jj/.local/share/weiwu/releases/weiwu-task-organization-20261018')
for rel in ['node_modules','services/agent-runtime/node_modules']:(repo/rel).symlink_to(live/rel,target_is_directory=True)
node='/home/jj/.local/share/weiwu/runtime/node-v24.19.0-linux-x64/bin/node'
env={'PATH':str(pathlib.Path(node).parent)+':/usr/bin:/bin','HOME':str(base),'LANG':'C.UTF-8'}
commands={
 'unit':[node,'--import','tsx','--test',*['tests/'+name+'.test.ts' for name in ['delivery-binding-feedback','organization-task-planning','orchestration-contracts','orchestration-patterns','organization-draft-diagnostics','organization-routing','task-contracts','organization-draft','planning-acceptance']]],
 'api':[node,'scripts/test-integration.mjs','tests/orchestration-pattern-integration.test.ts','tests/organization-chat.test.ts','tests/organization-routing-confirmation.test.ts'],
}
report={'sourceCommit':'0f55e13','modelCalls':0,'productionWrites':0,'checks':{},'sha256':{f:hashlib.sha256((repo/f).read_bytes()).hexdigest() for f in files}}
for name,args in commands.items():
 with (base/(name+'.txt')).open('w') as output:r=subprocess.run(args,cwd=repo,env=env,stdout=output,stderr=subprocess.STDOUT,timeout=180)
 report['checks'][name]=r.returncode
 (base/'results.json').write_text(json.dumps(report,indent=2))
 print(json.dumps({'check':name,'exitCode':r.returncode}),flush=True)
 if r.returncode:raise SystemExit(r.returncode)
print('Isolated checks complete: no production configuration, model calls, or service restart.',flush=True)
