"""Patch two tested planning files only; preserve originals and reject active work."""
import hashlib, json, os, pathlib, shutil, subprocess, sys, time, urllib.request
os.umask(0o077)
BASE = pathlib.Path('/home/jj/.local/share/weiwu/validation/task-driven-organization-20261018/planning-fix-20261019')
RELEASE = pathlib.Path('/home/jj/.local/share/weiwu/releases/weiwu-task-organization-20261018')
FILES = ['apps/api/src/organization-chat.ts', 'apps/api/src/organization-task-planning.ts']
if sys.argv[1:]==['lineage']:
    BASE=BASE.parent/'lineage-fix-20261019'
    FILES=['packages/contracts/run-lineage-evidence.ts']
elif sys.argv[1:]==['lineage-v2']:
    BASE=BASE.parent/'lineage-fix-v2-20261019'
    FILES=['packages/contracts/run-lineage-evidence.ts','apps/api/src/run-lineage-evidence.ts']
elif sys.argv[1:]:
    raise RuntimeError('Unknown patch scope')
def api(route):
    with urllib.request.urlopen('http://127.0.0.1:4310/api/' + route, timeout=15) as r: return json.load(r)
def sha(data): return hashlib.sha256(data).hexdigest()
def staged_name(path):return path.replace('/','__') if sys.argv[1:]==['lineage-v2'] else pathlib.Path(path).name
if __name__ == '__main__':
    manifest = json.loads((BASE / 'manifest.json').read_text())
    assert set(manifest) == set(FILES)
    assert not [r for r in api('runs') if r['status'] in ['running','queued']]
    assert all(c['status'] == 'uncertain' for c in api('costs')['calls'])
    for path in FILES:
        assert sha((RELEASE / path).read_bytes().replace(b'\r\n',b'\n')) == manifest[path]['old']
        assert sha((BASE / staged_name(path)).read_bytes()) == manifest[path]['new']
    backup = BASE / 'originals'; backup.mkdir(exist_ok=False)
    for path in FILES: shutil.copy2(RELEASE / path, backup / staged_name(path))
    if sys.argv[1:]==['lineage-v2']:shutil.copytree(RELEASE/'dist/web',backup/'dist-web')
    subprocess.run(['systemctl','--user','stop','weiwu-jj.service'],check=True)
    try:
        for path in FILES: shutil.copy2(BASE / staged_name(path), RELEASE / path)
        if sys.argv[1:]==['lineage-v2']:
            subprocess.run(['/home/jj/.local/share/weiwu/runtime/node-v24.19.0-linux-x64/bin/node','node_modules/vite/bin/vite.js','build'],cwd=RELEASE,check=True)
        subprocess.run(['systemctl','--user','start','weiwu-jj.service'],check=True)
        for _ in range(40):
            try:
                health=api('health')
                if health['database']=='connected': break
            except Exception: pass
            time.sleep(.5)
        else: raise RuntimeError('Patched service failed health check')
    except Exception:
        subprocess.run(['systemctl','--user','stop','weiwu-jj.service'],check=True)
        for path in FILES: shutil.copy2(backup / staged_name(path), RELEASE / path)
        if sys.argv[1:]==['lineage-v2']:shutil.copytree(backup/'dist-web',RELEASE/'dist/web',dirs_exist_ok=True)
        subprocess.run(['systemctl','--user','start','weiwu-jj.service'],check=True)
        raise
    result={'passed':True,'files':manifest,'health':health,'newModelCalls':0,'originals':str(backup)}
    (BASE/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)); print(json.dumps(result,ensure_ascii=False))
