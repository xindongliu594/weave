"""Finish this continuously stopped release after the copy-path guard fix.

Not a general retry: the isolated copy is valid only while no other process has
opened the stopped production database. A later restart requires a fresh backup.
"""
import hashlib,json,os,pathlib,subprocess,time,urllib.request
os.umask(0o077)
root=pathlib.Path('/home/jj/.local/share/weiwu')
phase=root/'validation/mvp-hardening-final-20261020'
release=root/'releases/weiwu-hardening-final-20261020'
old=root/'releases/weiwu-hardening-20261020'
backup=root/'backups/mvp-hardening-final-predeploy-20261020'
unit=pathlib.Path('/home/jj/.config/systemd/user/weiwu-jj.service')
service='weiwu-jj.service'
def cmd(*args):return subprocess.check_output(args,text=True).strip()
def api(path):
 with urllib.request.urlopen('http://127.0.0.1:4310/api/'+path,timeout=20) as response:return json.load(response)
def start_healthy():
 subprocess.run(['systemctl','--user','daemon-reload'],check=True)
 subprocess.run(['systemctl','--user','start',service],check=True)
 for _ in range(30):
  try:
   if api('health')['database']=='connected':return
  except Exception:pass
  time.sleep(1)
 raise RuntimeError('Health did not recover')
assert cmd('id','-un')=='jj'
assert cmd('systemctl','--user','show',service,'--property=ActiveState','--value')=='inactive'
assert cmd('systemctl','--user','show',service,'--property=WorkingDirectory','--value')==str(old)
original=(backup/'weiwu-jj.service').read_text()
assert unit.read_text()==original and original.count('WorkingDirectory='+str(old))==1
assert (backup/'data/database').is_dir() and (release/'dist/web/index.html').is_file()
assert all(p.resolve()==p for p in [phase,release,old,backup])
assert not (phase/'deployment.json').exists()
node=root/'runtime/node-v24.19.0-linux-x64/bin/node'
audit=subprocess.check_output([str(node),str(release/'scripts/validation/mvp-hardening/verify-stopped-database.mjs'),str(phase/'stopped-database-check')],text=True,timeout=60)
assert not any(json.loads(audit).values())
(phase/'stopped-database-check.json').write_text(audit)
before=json.loads((root/'validation/mvp-hardening-20261020/deployment.json').read_text())['before']
try:
 temporary=unit.with_suffix('.final.tmp');temporary.write_text(original.replace('WorkingDirectory='+str(old),'WorkingDirectory='+str(release)));temporary.chmod(0o600);os.replace(temporary,unit)
 start_healthy()
 usage=api('usage');costs=api('costs')
 assert len(usage)==before['usageCount'] and sum(float(row['cost']) for row in usage)==before['spent']
 assert [{key:row[key] for key in ['id','status','amount']} for row in costs['calls']]==before['uncertain']
 result={'passed':True,'release':str(release),'backup':str(backup),'modelCalls':0,'database':'connected','usageCount':len(usage),'unknownHolds':len(costs['calls']),'packageSha256':(phase/'release.sha256').read_text().strip(),'overlay':{'scripts/validation/mvp-hardening/verify-stopped-database.mjs':hashlib.sha256((release/'scripts/validation/mvp-hardening/verify-stopped-database.mjs').read_bytes()).hexdigest()},'stoppedAudit':json.loads(audit)}
 (phase/'deployment.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
except BaseException:
 subprocess.run(['systemctl','--user','stop',service],check=True)
 temporary=unit.with_suffix('.final-rollback.tmp');temporary.write_text(original);temporary.chmod(0o600);os.replace(temporary,unit)
 start_healthy();raise
