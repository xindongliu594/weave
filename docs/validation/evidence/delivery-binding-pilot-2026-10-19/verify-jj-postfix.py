import pathlib,subprocess,json,hashlib
root=pathlib.Path('/home/jj/.local/share/weiwu');trial=root/'validation/delivery-binding-pilot-20261019-a05f034'
base=trial/'postfix';base.mkdir(exist_ok=False);repo=base/'source';repo.mkdir()
for archive in [trial/'source-a05f034.tar.gz',trial/'postfix-overlay.tar.gz']:
 subprocess.run(['tar','-xzf',str(archive),'-C',str(repo)],check=True)
live=root/'releases/weiwu-task-organization-20261018'
for rel in ['node_modules','services/agent-runtime/node_modules']:(repo/rel).symlink_to(live/rel,target_is_directory=True)
node=root/'runtime/node-v24.19.0-linux-x64/bin/node'
env={'PATH':str(node.parent)+':/usr/bin:/bin','HOME':str(base),'LANG':'C.UTF-8'}
unit=['tests/'+name+'.test.ts' for name in ['delivery-binding-feedback','organization-task-planning','orchestration-contracts','orchestration-patterns','organization-draft-diagnostics','organization-routing','task-contracts','organization-draft','planning-acceptance']]
unit+=['scripts/validation/orchestration-planning-pilot/'+name+'.test.mjs' for name in ['limits','lifecycle','feedback','delivery-binding']]
checks={'unit':[str(node),'--import','tsx','--test',*unit],'api':[str(node),'scripts/test-integration.mjs','tests/orchestration-pattern-integration.test.ts','tests/organization-chat.test.ts','tests/organization-routing-confirmation.test.ts']}
files=['apps/api/src/execution-prompt.ts','apps/api/src/organization-task-planning.ts','tests/planning-acceptance.test.ts','tests/orchestration-pattern-integration.test.ts']
report={'sourceCommit':'a05f034','modelCalls':0,'productionWrites':0,'checks':{},'sha256':{f:hashlib.sha256((repo/f).read_bytes()).hexdigest() for f in files}}
for name,args in checks.items():
 with (base/(name+'.txt')).open('w') as output:r=subprocess.run(args,cwd=repo,env=env,stdout=output,stderr=subprocess.STDOUT,timeout=180)
 report['checks'][name]=r.returncode;(base/'results.json').write_text(json.dumps(report,indent=2))
 print(json.dumps({'check':name,'exitCode':r.returncode}),flush=True)
 if r.returncode:raise SystemExit(r.returncode)
