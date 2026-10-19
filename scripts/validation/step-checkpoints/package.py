"""Package tracked source plus this phase's explicit new files. No data or keys."""
import hashlib,json,pathlib,subprocess,tarfile
root=pathlib.Path(__file__).resolve().parents[3]
out=root/'.superpowers/sdd/2026-10-19-step-checkpoints'
paths=subprocess.check_output(['git','ls-files','-z'],cwd=root).decode().split('\0')
selected={p for p in paths if p and (p.split('/')[0] in ['apps','services','packages','tests','scripts'] or p in ['package.json','package-lock.json','tsconfig.json','vite.config.ts'])}
selected.update(['apps/api/src/step-checkpoint-recovery.ts','apps/desktop/checkpoint-test-profile.cjs','apps/web/src/RunStepCheckpoints.tsx',
    'services/agent-runtime/inherited-step-evidence.test.mjs','services/agent-runtime/step-checkpoint-crash.test.mjs',
    'tests/checkpoint-branch.test.ts','tests/checkpoint-test-profile.test.mjs'])
selected.update(p.relative_to(root).as_posix() for p in (root/'scripts/validation/step-checkpoints').glob('*') if p.is_file())
selected.update(p.relative_to(root).as_posix() for p in (root/'dist/web').rglob('*') if p.is_file())
manifest=[]
with tarfile.open(out/'release.tar.gz','w:gz') as archive:
    for name in sorted(selected):
        path=root/name
        assert not path.is_symlink() and path.is_file(),name
        assert all(part not in ['node_modules','.env','.data','.git'] for part in path.relative_to(root).parts),name
        archive.add(path,arcname=name,recursive=False)
        manifest.append({'path':name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
digest=hashlib.sha256((out/'release.tar.gz').read_bytes()).hexdigest()
(out/'release.sha256').write_text(digest)
(out/'source-manifest.json').write_text(json.dumps(manifest,indent=2))
print(json.dumps({'files':len(manifest),'bytes':(out/'release.tar.gz').stat().st_size,'sha256':digest}))
