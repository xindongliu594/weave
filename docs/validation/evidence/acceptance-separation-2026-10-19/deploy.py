from pathlib import Path
import hashlib, json, shutil, subprocess, tarfile, time, urllib.request

base = Path('/home/jj/.local/share/weiwu/validation/acceptance-separation-20261019-3ea081e')
release = Path('/home/jj/.local/share/weiwu/releases/weiwu-task-organization-20261018')
source = base / 'source'
expected = set('''apps/api/src/app.ts
apps/api/src/execution-prompt.ts
apps/api/src/organization-chat.ts
apps/api/src/organization-draft-diagnostics.ts
apps/api/src/organization-routing.ts
apps/api/src/organization-task-planning.ts
apps/api/src/product.ts
apps/web/src/AcceptanceCheckEditor.tsx
apps/web/src/OrganizationCenter.tsx
apps/web/src/OrganizationRecommendation.tsx
apps/web/src/RunAcceptanceChecks.tsx
packages/contracts/acceptance-commands.ts
packages/contracts/index.ts
packages/contracts/orchestration-patterns.ts
packages/contracts/orchestration.ts'''.splitlines())
assert set(json.loads((base/'predeploy.json').read_text())['normalizedDifferences']) == expected
assert all(code == 0 for code in json.loads((base/'checks.json').read_text()).values())
related = json.loads((base/'related-checks.json').read_text())
assert related['related-unit'] == 0 and related['related-api-final'] == 0
manifest = json.loads((base/'source-manifest.json').read_text())
for path, digest in manifest.items():
    assert hashlib.sha256((source/path).read_bytes()).hexdigest() == digest, path
with tarfile.open(base/'web.tar.gz') as archive:
    assert all(item.name.startswith('dist/web/') or item.name == 'web-manifest.json' for item in archive.getmembers())
    archive.extractall(base, filter='data')
web = json.loads((base/'web-manifest.json').read_text())
for path, digest in web.items():
    assert hashlib.sha256((base/path).read_bytes()).hexdigest() == digest, path
def get(endpoint):
    return json.load(urllib.request.urlopen('http://127.0.0.1:4310/api/'+endpoint, timeout=8))
assert not [r for r in get('runs') if r.get('status') in ['running','queued','stopping']], 'Active run; do not deploy'
backup = base/'production-backup'
backup.mkdir(exist_ok=False)
paths = sorted(expected | set(web))
prior = {}
for path in paths:
    target = release/path
    assert target.resolve().is_relative_to(release.resolve())
    if target.exists():
        prior[path] = hashlib.sha256(target.read_bytes()).hexdigest()
        (backup/path).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(target, backup/path)
    else: prior[path] = None
(backup/'manifest.json').write_text(json.dumps(prior, indent=2))
def service(action): subprocess.run(['systemctl','--user',action,'weiwu-jj.service'],check=True,timeout=30)
def health():
    for _ in range(30):
        try:
            h=get('health')
            if h.get('database')=='connected' and h.get('runtime',{}).get('ready'): return h
        except Exception: pass
        time.sleep(.5)
    raise RuntimeError('Health check failed')
result = {'sourceFiles':len(expected),'webFiles':len(web),'backup':str(backup),'modelCalls':0}
service('stop')
try:
    for path in paths:
        target=release/path; target.parent.mkdir(parents=True,exist_ok=True)
        temp=target.with_name(target.name+'.acceptance-stage')
        shutil.copy2((source if path in expected else base)/path,temp)
        temp.replace(target)
    service('start');health()
    expected_hashes={**{p:manifest[p] for p in expected},**web}
    assert all(hashlib.sha256((release/p).read_bytes()).hexdigest()==h for p,h in expected_hashes.items())
    result.update({'passed':True,'hashes':expected_hashes,'activeRuns':[r['id'] for r in get('runs') if r.get('status') in ['running','queued','stopping']]})
except Exception:
    service('stop')
    for path,old in prior.items():
        target=release/path
        if old is None: target.unlink(missing_ok=True)
        else: shutil.copy2(backup/path,target)
    service('start');health()
    result.update({'passed':False,'rollbackPassed':True})
    (base/'deployment.json').write_text(json.dumps(result,indent=2))
    raise
(base/'deployment.json').write_text(json.dumps(result,indent=2))
print(json.dumps({k:v for k,v in result.items() if k!='hashes'}))
