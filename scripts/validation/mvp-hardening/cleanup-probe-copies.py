"""Remove only this phase's two verified disposable copies; keep original backup."""
import json,pathlib,shutil,sys
base=pathlib.Path('/home/jj/.local/share/weiwu')
assert sys.argv[1:] in [[],['--apply'],['--final-check'],['--final-apply'],['--runtime-check'],['--runtime-apply']]
suffix='-runtime' if sys.argv[1:] and sys.argv[1].startswith('--runtime-') else '-final' if sys.argv[1:] and sys.argv[1].startswith('--final-') else ''
phase=base/('validation/mvp-hardening'+suffix+'-20261020')
if suffix:
 deployment=json.loads((phase/'deployment.json').read_text())
 assert deployment['passed'] and not any(deployment['stoppedAudit'].values())
 report={'source':str(base/('backups/mvp-hardening'+suffix+'-predeploy-20261020/data'))}
 assert pathlib.Path(deployment['backup'])==pathlib.Path(report['source']).parent
 targets=[phase/'stopped-database-check'];evidence=phase/'deployment.json'
else:
 report=json.loads((phase/'restore-audit.json').read_text())
 assert report['passed'] and report['readOnlyReopenedTwice'] and report['originalBackupUnchanged']
 assert pathlib.Path(report['source'])==base/'backups/mvp-hardening-predeploy-20261020/data'
 targets=[phase/'stopped-database-check',base/'releases/weiwu-hardening-20261020/.data/hardening-isolated-restore']
 assert pathlib.Path(report['restore'])==targets[1]
 evidence=phase/'restore-audit.json'
assert pathlib.Path(report['source']).is_dir()
proof=[]
for target in targets:
 assert target.resolve()==target and target.is_relative_to(base) and target.is_dir() and not target.is_symlink()
 assert not (target/'postmaster.pid').exists() and not (target/'database/postmaster.pid').exists()
 files=list(target.rglob('*'));assert not any(p.is_symlink() for p in files)
 proof.append({'path':str(target),'bytes':sum(p.stat().st_size for p in files if p.is_file())})
if sys.argv[1:] in [['--apply'],['--final-apply'],['--runtime-apply']]:
 destination=phase/'probe-cleanup.json';assert not destination.exists()
 # Re-assert each literal resolved path at the mutation boundary.
 for target in targets:
  assert target.resolve()==target and target in targets and target.is_relative_to(base)
  shutil.rmtree(target)
 result={'removed':proof,'originalBackupRetained':report['source'],'modelCalls':0,'evidenceRetained':str(evidence)}
 destination.write_text(json.dumps(result,indent=2));print(json.dumps(result))
else:print(json.dumps({'preflight':True,'targets':proof,'originalBackupRetained':report['source']}))
