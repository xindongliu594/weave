"""Add hashed assets first, replace the HTML index last; no service restart."""
import hashlib,json,os,pathlib,subprocess,tarfile
os.umask(0o077)
base=pathlib.Path('/home/jj/.local/share/weiwu/validation/mvp-hardening-20261020')
release=pathlib.Path('/home/jj/.local/share/weiwu/releases/weiwu-hardening-20261020')
assert subprocess.check_output(['systemctl','--user','show','weiwu-jj.service','--property=WorkingDirectory','--value'],text=True).strip()==str(release)
report=base/'ui-overlay.json';assert not report.exists(),'Inspect earlier publication before retry'
sources={'apps/web/src/RunExtras.tsx','apps/web/src/RunHandoffReports.tsx','apps/web/src/RunStepCheckpoints.tsx'}
with tarfile.open(base/'ui-overlay.tar.gz','r:gz') as archive:files={e.name:archive.extractfile(e).read() for e in archive if e.isfile()}
assert sources.issubset(files) and 'dist/web/index.html' in files
assert all(n in sources or n=='dist/web/index.html' or (n.startswith('dist/web/assets/') and pathlib.PurePosixPath(n).name==n.split('/')[-1]) for n in files)
assert all('..' not in pathlib.PurePosixPath(n).parts and (release/n).resolve().is_relative_to(release) for n in files)
with tarfile.open(base/'release.tar.gz','r:gz') as original:
 for name in sources|{'dist/web/index.html'}:assert (release/name).read_bytes()==original.extractfile(name).read(),'Deployed source changed: '+name
backup=base/'ui-original';backup.mkdir()
for name in sources|{'dist/web/index.html'}:
 target=backup/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes((release/name).read_bytes())
for name in sorted(files,key=lambda n:n=='dist/web/index.html'):
 target=release/name;temporary=target.with_name(target.name+'.publishing');assert not temporary.exists()
 with temporary.open('xb') as file:file.write(files[name]);file.flush();os.fsync(file.fileno())
 os.replace(temporary,target)
proof={'passed':True,'serviceRestarted':False,'oldHashedAssetsRetained':True,'files':{n:hashlib.sha256(data).hexdigest() for n,data in files.items()}}
report.write_text(json.dumps(proof,indent=2));print(json.dumps(proof))
