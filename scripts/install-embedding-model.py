#!/usr/bin/env python3
"""Download only pinned public model artifacts; never uploads workspace data."""
import hashlib,json,os,pathlib,urllib.request
root=pathlib.Path(__file__).resolve().parent.parent
lock=json.loads((root/'services/embedding/model-lock.json').read_text())
dest=pathlib.Path(os.environ.get('EMBEDDING_MODEL_DIR',str(root/'.data/embedding-models')))/lock['repository']
for name,expected in lock['files'].items():
 target=dest/name;target.parent.mkdir(parents=True,exist_ok=True)
 if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest()==expected:
  print('Verified',name,flush=True);continue
 temp=target.with_name(target.name+'.partial');digest=hashlib.sha256()
 try:
  url='https://huggingface.co/'+lock['repository']+'/resolve/'+lock['revision']+'/'+name
  with urllib.request.urlopen(url,timeout=60) as response,temp.open('wb') as output:
   while True:
    chunk=response.read(1024*1024)
    if not chunk:break
    digest.update(chunk);output.write(chunk)
  if digest.hexdigest()!=expected:raise RuntimeError('Model checksum mismatch: '+name)
  temp.replace(target);print('Installed',name,flush=True)
 finally:
  if temp.exists():temp.unlink()
print('Pinned embedding model ready:',dest,flush=True)
