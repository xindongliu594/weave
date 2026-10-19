"""After explicit approval, keep only two live configuration values inside JJ."""
import os,pathlib,subprocess,sys
assert sys.argv[1:] in [['--approved-real'],['--approved-real','repair-smoke'],['--approved-real','feedback-correction'],['--approved-real','delivery-binding'],['--approved-real','planning-ab'],['--approved-real','planning-ab-independent']]
profile=sys.argv[2] if len(sys.argv)==3 else 'original'
root=pathlib.Path('/home/jj/.local/share/weiwu')
base=root/'validation'/({'original':'orchestration-20261019-580aafb','repair-smoke':'orchestration-smoke-20261019-4283f2b','feedback-correction':'orchestration-correction-20261019-5055aab','delivery-binding':'delivery-binding-pilot-20261019-a05f034','planning-ab':'planning-ab-20261019-db8153d','planning-ab-independent':'planning-ab-20261019-db8153d'}[profile]);repo=base/'source'
output=base/('deepseek-only' if profile=='planning-ab-independent' else 'real')
live=pathlib.Path(subprocess.check_output(['systemctl','--user','show','weiwu-jj.service','--property=WorkingDirectory','--value'],text=True).strip())
assert live==root/'releases/weiwu-task-organization-20261018';assert not output.exists()
matches=[]
for p in pathlib.Path('/proc').iterdir():
 if not p.name.isdigit():continue
 try:
  if b'scripts/local-api.ts' in (p/'cmdline').read_bytes().split(b'\0') and (p/'cwd').resolve()==live:matches.append(p)
 except (PermissionError,FileNotFoundError,ProcessLookupError):pass
assert len(matches)==1
node=root/'runtime/node-v24.19.0-linux-x64/bin/node';env={'PATH':str(node.parent)+':/usr/bin:/bin','HOME':str(pathlib.Path.home())}
raw=(matches[0]/'environ').read_bytes()
for item in raw.split(b'\0'):
 key,sep,value=item.partition(b'=')
 if sep and key in [b'DATABASE_URL',b'DATA_DIR']:env[key.decode()]=value.decode()
del raw
assert env.get('DATA_DIR')==str(root/'data/pilot/credentials')
assert env.get('DATABASE_URL','').startswith('postgresql://postgres:postgres@127.0.0.1:')
os.umask(0o077)
driver='ab-broker.mjs' if profile.startswith('planning-ab') else 'broker.mjs'
result=subprocess.run([str(node),'--import',str(repo/'node_modules/tsx/dist/loader.mjs'),str(repo/'scripts/validation/orchestration-planning-pilot'/driver),'approved-real',str(repo),str(output),profile],cwd=repo,env=env)
sys.exit(result.returncode)
