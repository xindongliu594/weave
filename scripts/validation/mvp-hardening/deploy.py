"""One release, no model calls. --check is read-only; --apply backs up stopped data.

Run as JJ's user. Do not print or copy runtime credentials outside JJ.
"""
import hashlib, json, os, pathlib, re, shutil, subprocess, sys, tarfile, time, urllib.request
os.umask(0o077)

assert sys.argv[1:] in [['--check'],['--apply'],['--final-check'],['--final-apply'],['--runtime-check'],['--runtime-apply'],['--correction-check'],['--correction-apply'],['--correction-resume'],['--admission-check'],['--admission-apply'],['--snapshot-check'],['--snapshot-apply'],['--coordination-check'],['--coordination-apply']]
phase='coordination' if sys.argv[1].startswith('--coordination-') else 'snapshot' if sys.argv[1].startswith('--snapshot-') else 'admission' if sys.argv[1].startswith('--admission-') else 'correction' if sys.argv[1].startswith('--correction-') else 'runtime' if sys.argv[1].startswith('--runtime-') else 'final' if sys.argv[1].startswith('--final-') else 'initial'
resume=sys.argv[1]=='--correction-resume'
apply=sys.argv[1].endswith('apply') or resume
ROOT=pathlib.Path('/home/jj/.local/share/weiwu')
suffix={'initial':'','final':'-final','runtime':'-runtime','correction':'-correction','admission':'-admission','snapshot':'-snapshot','coordination':'-coordination'}[phase]
BASE=ROOT/('validation/mvp-hardening'+suffix+'-20261020')
RELEASE=ROOT/('releases/weiwu-hardening'+suffix+'-20261020')
OLD=ROOT/('releases/'+{'initial':'weiwu-step-checkpoints-v2-20261020','final':'weiwu-hardening-20261020','runtime':'weiwu-hardening-final-20261020','correction':'weiwu-hardening-runtime-20261020','admission':'weiwu-hardening-correction-20261020','snapshot':'weiwu-hardening-admission-20261020','coordination':'weiwu-hardening-snapshot-20261020'}[phase])
DATA=ROOT/'data/pilot'
BACKUP=ROOT/('backups/mvp-hardening'+suffix+'-predeploy-20261020')
UNIT=pathlib.Path('/home/jj/.config/systemd/user/weiwu-jj.service')
SERVICE='weiwu-jj.service'

def command(*args):
    return subprocess.check_output(args,text=True).strip()

def api(path):
    with urllib.request.urlopen('http://127.0.0.1:4310/api/'+path,timeout=25) as r:
        return json.load(r)

def bounded(path,parent):
    assert path.resolve().is_relative_to(parent.resolve()), 'Path outside expected root'

def wait_health():
    for _ in range(30):
        try:
            if api('health')['database']=='connected':return
        except Exception:pass
        time.sleep(1)
    raise RuntimeError('Health did not recover')

def rollback_service(original):
    # start is a no-op for an already active new process: stop it first.
    subprocess.run(['systemctl','--user','stop',SERVICE],check=True)
    temporary=UNIT.with_suffix('.rollback.tmp');temporary.write_text(original);temporary.chmod(0o600);os.replace(temporary,UNIT)
    subprocess.run(['systemctl','--user','daemon-reload'],check=True)
    subprocess.run(['systemctl','--user','start',SERVICE],check=True)
    assert command('systemctl','--user','show',SERVICE,'--property=WorkingDirectory','--value')==str(OLD)
    wait_health()

def idle_snapshot():
    assert api('health')['database']=='connected'
    assert not any(r['status'] in ['queued','running'] for r in api('runs')), 'Active run: do not restart'
    costs=api('costs');assert not any(c['status']=='pending' for c in costs['calls']), 'Pending model call: do not restart'
    usage=api('usage')
    return {'usageCount':len(usage),'spent':sum(float(row['cost']) for row in usage),'uncertain':[{k:c[k] for k in ['id','status','amount']} for c in costs['calls']]}

assert command('id','-un')=='jj'
assert command('systemctl','--user','show',SERVICE,'--property=WorkingDirectory','--value')==str(OLD)
original=UNIT.read_text()
assert original.count('WorkingDirectory='+str(OLD))==1
for path in [BASE,RELEASE,OLD,DATA,BACKUP]: bounded(path,ROOT)
assert not BACKUP.exists() and (RELEASE.is_dir() if resume else not RELEASE.exists()), 'Release/backup state changed; inspect rather than replay'
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
before=idle_snapshot()
if not apply:
    print(json.dumps({'preflight':True,'modelCalls':0,'before':before,'packageSha256':expected}));sys.exit(0)

if not resume:RELEASE.mkdir()
with tarfile.open(package,'r:gz') as archive:
    for entry in archive:
        target=RELEASE/entry.name
        if entry.isdir(): target.mkdir(parents=True,exist_ok=True)
        else:
            if resume:
                assert target.is_file() and not target.is_symlink() and hashlib.sha256(target.read_bytes()).digest()==hashlib.sha256(archive.extractfile(entry).read()).digest(),'Prepared release differs from original package: '+entry.name
                continue
            target.parent.mkdir(parents=True,exist_ok=True)
            with archive.extractfile(entry) as src,open(target,'xb') as dst: shutil.copyfileobj(src,dst)
            target.chmod(entry.mode & 0o777)
for relative in ['node_modules','services/agent-runtime/node_modules']:
    if resume:assert (RELEASE/relative).is_symlink() and (RELEASE/relative).resolve()==(OLD/relative).resolve()
    else:(RELEASE/relative).symlink_to(OLD/relative,target_is_directory=True)
assert (RELEASE/'dist/web/index.html').is_file()
assert (RELEASE/'apps/api/src/step-checkpoint-recovery.ts').is_file()
assert (RELEASE/'apps/desktop/checkpoint-test-profile.cjs').is_file()
node=ROOT/'runtime/node-v24.19.0-linux-x64/bin/node'
with (BASE/'linux-tests.txt').open('w') as evidence:
    subprocess.run(([str(node),'--import','tsx','--test','--test-concurrency=1','tests/recovery-resource-plan.test.ts','tests/run-resource-resume.test.ts','tests/recovery-conditions-ui.test.ts','services/agent-runtime/budget.test.mjs','services/agent-runtime/coordinator-budget.test.mjs','services/agent-runtime/model-settlement.test.mjs'] if phase=='coordination' else [str(node),'--test','services/agent-runtime/model-settlement.test.mjs','services/agent-runtime/responses-compatible.test.mjs'] if phase=='snapshot' else [str(node),'--import','tsx','--test','tests/organization-failed-draft.test.ts','scripts/validation/task-driven-organization/remaining-call-budget.test.mjs'] if phase=='admission' else [str(node),'--test','services/agent-runtime/supervisor.test.mjs',
        'services/agent-runtime/supervisor-persistence.test.mjs','services/agent-runtime/step-checkpoints.test.mjs',
        'services/agent-runtime/inherited-step-evidence.test.mjs','services/agent-runtime/storage-governance.test.mjs',
        'services/agent-runtime/sandbox-checkpoint.test.mjs','services/agent-runtime/step-checkpoint-crash.test.mjs',
        'services/agent-runtime/employee-checkpoint-policy.test.mjs',
        'services/agent-runtime/coordinator-context.test.mjs','services/agent-runtime/responses-compatible.test.mjs',
        'services/agent-runtime/delivery-settlement.test.mjs','services/agent-runtime/model-settlement.test.mjs',
        'services/agent-runtime/product-tools.test.mjs','services/agent-runtime/task-plan-context.test.mjs',
        'services/agent-runtime/task-output-limit-native.test.mjs','services/agent-runtime/handoff-fixtures.test.mjs',
        'scripts/validation/step-checkpoints/controlled-step-boundary.test.mjs']),
        cwd=RELEASE,stdout=evidence,stderr=subprocess.STDOUT,check=True,timeout=120,
        env={**os.environ,'PATH':str(node.parent)+':'+os.environ.get('PATH','')})
with (BASE/'linux-backup.txt').open('w') as evidence:
    subprocess.run([str(node),'scripts/test-integration.mjs','tests/extensions-backup.test.ts',*(['tests/recovery-conditions.test.ts'] if phase=='coordination' else ['tests/api.test.ts','tests/organization-routing-confirmation.test.ts','tests/openshell-api-admission.test.ts'] if phase=='snapshot' else ['tests/organization-chat.test.ts','tests/orchestration-pattern-integration.test.ts'] if phase in ['correction','admission'] else [])],
        cwd=RELEASE,stdout=evidence,stderr=subprocess.STDOUT,check=True,timeout=180,
        env={**os.environ,'PATH':str(node.parent)+':'+os.environ.get('PATH','')})
# This is an announced, idle maintenance window, not a concurrent-deployment API.
# Existing stop closes ingress but may abort in-flight requests. Recheck after tests;
# any new activity invalidates this deployment rather than being silently adopted.
assert idle_snapshot()==before, 'Activity during maintenance preparation; inspect and schedule a new idle window'
changed=False;stopped_database_verified=False
try:
    subprocess.run(['systemctl','--user','stop',SERVICE],check=True)
    assert command('systemctl','--user','show',SERVICE,'--property=ActiveState','--value')=='inactive'
    BACKUP.mkdir(parents=True)
    shutil.copytree(DATA,BACKUP/'data',symlinks=True)
    (BACKUP/'weiwu-jj.service').write_text(original)
    disposable=BASE/'stopped-database-check';assert not disposable.exists()
    shutil.copytree(BACKUP/'data/database',disposable,symlinks=False)
    with (BASE/'stopped-database-check.json').open('w') as evidence:
        subprocess.run([str(node),str(RELEASE/'scripts/validation/mvp-hardening/verify-stopped-database.mjs'),str(disposable)],cwd=RELEASE,stdout=evidence,stderr=subprocess.STDOUT,check=True,timeout=60)
    stopped_database_verified=True
    replacement=original.replace('WorkingDirectory='+str(OLD),'WorkingDirectory='+str(RELEASE))
    temporary=UNIT.with_suffix('.mvp-hardening.tmp');temporary.write_text(replacement);temporary.chmod(0o600);os.replace(temporary,UNIT);changed=True
    subprocess.run(['systemctl','--user','daemon-reload'],check=True)
    subprocess.run(['systemctl','--user','start',SERVICE],check=True)
    wait_health()
    after_usage=api('usage');after_costs=api('costs')
    assert len(after_usage)==before['usageCount'], 'Unexpected model request during deployment'
    assert [{k:c[k] for k in ['id','status','amount']} for c in after_costs['calls']]==before['uncertain']
    result={'passed':True,'release':str(RELEASE),'backup':str(BACKUP),'packageSha256':expected,'modelCalls':0,'database':'connected','before':before,'stoppedAudit':json.loads((BASE/'stopped-database-check.json').read_text()),'note':'Old release and stopped data copy retained; additive migration only.'}
    (BASE/'deployment.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
except BaseException:
    # If a late request appeared, keep the stopped service for inspection. An
    # automatic restart could dispatch its queued work without our knowledge.
    if stopped_database_verified:rollback_service(original)
    else:print(json.dumps({'stoppedForInspection':True,'reason':'Stopped database was not certified idle; no automatic restart','initiatedModelCalls':0,'concurrentActivity':'not certified'}))
    raise
