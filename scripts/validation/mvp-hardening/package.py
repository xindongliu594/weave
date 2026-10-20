"""Reuse the previous release packaging rules, with an explicit list of this phase's new code."""
import hashlib,json,pathlib,subprocess,tarfile
root=pathlib.Path(__file__).resolve().parents[3]
out=root/'.superpowers/sdd/2026-10-20-mvp-hardening'
tracked=subprocess.check_output(['git','ls-files','-z'],cwd=root).decode().split('\0')
selected={p for p in tracked if p and (p.split('/')[0] in ['apps','services','packages','tests','scripts'] or p in ['package.json','package-lock.json','tsconfig.json','vite.config.ts'])}
selected.update(['apps/api/src/backup-checkpoints.ts','apps/api/src/organization-failed-draft.ts','tests/organization-failed-draft.test.ts','services/agent-runtime/supervisor-persistence.test.mjs','services/agent-runtime/sandbox-checkpoint.test.mjs','services/agent-runtime/coordinator-context.test.mjs','tests/backup-checkpoints.test.ts'])
selected.update(['docs/validation/evidence/'+name for name in ['orchestration-jj-tests-2026-10-19/real-evaluation.json','orchestration-smoke-2026-10-19/real/broker-result.json','orchestration-feedback-pilot-2026-10-19/real/broker-result.json','delivery-binding-pilot-2026-10-19/real/broker-result.json']])
for folder in ['scripts/validation/mvp-hardening','scripts/validation/step-checkpoints']:
    selected.update(p.relative_to(root).as_posix() for p in (root/folder).iterdir() if p.is_file() and p.suffix in ['.py','.mjs','.cjs'])
selected.update(p.relative_to(root).as_posix() for p in (root/'dist/web').rglob('*') if p.is_file())
manifest=[]
with tarfile.open(out/'release.tar.gz','w:gz') as archive:
    for name in sorted(selected):
        path=root/name
        assert not path.is_symlink() and path.is_file(),name
        assert all(part not in ['node_modules','.env','.data','.git','__pycache__'] for part in path.relative_to(root).parts),name
        archive.add(path,arcname=name,recursive=False)
        manifest.append({'path':name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
digest=hashlib.sha256((out/'release.tar.gz').read_bytes()).hexdigest()
(out/'release.sha256').write_text(digest)
(out/'source-manifest.json').write_text(json.dumps(manifest,indent=2))
print(json.dumps({'files':len(manifest),'bytes':(out/'release.tar.gz').stat().st_size,'sha256':digest}))
