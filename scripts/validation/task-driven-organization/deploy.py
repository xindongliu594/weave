"""One release, no model calls. --check is read-only; --apply backs up stopped data.

Run as JJ's user. Do not print or copy runtime credentials outside JJ.
"""
import hashlib, json, os, pathlib, re, shutil, subprocess, sys, tarfile, time, urllib.request
os.umask(0o077)

ROOT=pathlib.Path('/home/jj/.local/share/weiwu')
BASE=ROOT/'validation/task-driven-organization-20261018'
RELEASE=ROOT/'releases/weiwu-task-organization-20261018'
OLD=ROOT/'releases/weiwu-native-capabilities-20261018'
DATA=ROOT/'data/pilot'
BACKUP=ROOT/'backups/task-organization-predeploy-20261018'
UNIT=pathlib.Path('/home/jj/.config/systemd/user/weiwu-jj.service')
SERVICE='weiwu-jj.service'

def command(*args):
    return subprocess.check_output(args,text=True).strip()

def api(path):
    with urllib.request.urlopen('http://127.0.0.1:4310/api/'+path,timeout=25) as r:
        return json.load(r)

def bounded(path,parent):
    assert path.resolve().is_relative_to(parent.resolve()), 'Path outside expected root'

assert sys.argv[1:] in [['--check'],['--apply']]
assert command('id','-un')=='jj'
assert command('systemctl','--user','show',SERVICE,'--property=WorkingDirectory','--value')==str(OLD)
original=UNIT.read_text()
assert original.count('WorkingDirectory='+str(OLD))==1
for path in [BASE,RELEASE,OLD,DATA,BACKUP]: bounded(path,ROOT)
assert not RELEASE.exists() and not BACKUP.exists(), 'Release/backup already exists; inspect rather than replay'
assert (OLD/'node_modules').is_dir() and (OLD/'services/agent-runtime/node_modules').is_dir()
assert shutil.disk_usage(ROOT).free>3*1024**3, 'Need at least 3 GiB free for release and backup'
package=BASE/'release.tar.gz'
expected=(BASE/'release.sha256').read_text().strip()
assert hashlib.sha256(package.read_bytes()).hexdigest()==expected
with tarfile.open(package,'r:gz') as archive:
    for entry in archive:
        path=pathlib.PurePosixPath(entry.name)
        assert path.parts and not path.is_absolute() and all(part not in ['..','.git','node_modules','.env'] for part in path.parts)
        assert entry.isfile() or entry.isdir(), 'Only regular files/directories allowed'
        bounded(RELEASE/path,RELEASE)
health=api('health');assert health['database']=='connected'
runs=api('runs');assert not any(r['status'] in ['queued','running'] for r in runs), 'Active run: do not restart'
costs=api('costs');assert not any(c['status']=='pending' for c in costs['calls']), 'Pending model call: do not restart'
usage=api('usage')
before={'usageCount':len(usage),'spent':sum(float(row['cost']) for row in usage),'uncertain':[{k:c[k] for k in ['id','status','amount']} for c in costs['calls']]}
if sys.argv[1]=='--check':
    print(json.dumps({'preflight':True,'modelCalls':0,'before':before,'packageSha256':expected}));sys.exit(0)

RELEASE.mkdir()
with tarfile.open(package,'r:gz') as archive:
    for entry in archive:
        target=RELEASE/entry.name
        if entry.isdir(): target.mkdir(parents=True,exist_ok=True)
        else:
            target.parent.mkdir(parents=True,exist_ok=True)
            with archive.extractfile(entry) as src,open(target,'xb') as dst: shutil.copyfileobj(src,dst)
            target.chmod(entry.mode & 0o777)
for relative in ['node_modules','services/agent-runtime/node_modules']:
    (RELEASE/relative).symlink_to(OLD/relative,target_is_directory=True)
assert (RELEASE/'dist/web/index.html').is_file()
assert (RELEASE/'apps/api/src/organization-turns.ts').is_file()
changed=False
try:
    subprocess.run(['systemctl','--user','stop',SERVICE],check=True)
    assert command('systemctl','--user','show',SERVICE,'--property=ActiveState','--value')=='inactive'
    BACKUP.mkdir(parents=True)
    shutil.copytree(DATA,BACKUP/'data',symlinks=True)
    (BACKUP/'weiwu-jj.service').write_text(original)
    replacement=original.replace('WorkingDirectory='+str(OLD),'WorkingDirectory='+str(RELEASE))
    temporary=UNIT.with_suffix('.task-organization.tmp');temporary.write_text(replacement);temporary.chmod(0o600);os.replace(temporary,UNIT);changed=True
    subprocess.run(['systemctl','--user','daemon-reload'],check=True)
    subprocess.run(['systemctl','--user','start',SERVICE],check=True)
    healthy=False
    for _ in range(30):
        try:
            healthy=api('health')['database']=='connected'
            if healthy: break
        except Exception: pass
        time.sleep(1)
    assert healthy, 'Health did not recover'
    after_usage=api('usage');after_costs=api('costs')
    assert len(after_usage)==before['usageCount'], 'Unexpected model request during deployment'
    assert [{k:c[k] for k in ['id','status','amount']} for c in after_costs['calls']]==before['uncertain']
    result={'passed':True,'release':str(RELEASE),'backup':str(BACKUP),'packageSha256':expected,'modelCalls':0,'database':'connected','before':before,'note':'Old release and stopped data copy retained; additive migration only.'}
    (BASE/'deployment.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
except BaseException:
    if changed:
        UNIT.write_text(original)
        subprocess.run(['systemctl','--user','daemon-reload'],check=True)
    subprocess.run(['systemctl','--user','start',SERVICE],check=True)
    raise
