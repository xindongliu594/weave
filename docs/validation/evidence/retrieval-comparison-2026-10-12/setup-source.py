from pathlib import Path
import urllib.request, json, re, hashlib, base64, tarfile, io
root=(Path.cwd()/'.data/retrieval-compare-20261012').resolve()
assert root.is_relative_to(Path.cwd().resolve())
root.mkdir(exist_ok=True)
def get(url):
    with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'Weiwu-isolated-retrieval-benchmark'}),timeout=60) as response:return response.read()
evidence={'scope':'isolated scratch, no product dependency/configuration change','packages':[]}
for name in ['@node-rs/jieba','@node-rs/jieba-win32-x64-msvc']:
    metadata=json.loads(get('https://registry.npmjs.org/'+name.replace('/','%2F')+'/2.0.4'))
    archive=get(metadata['dist']['tarball'])
    expected=metadata['dist']['integrity'];algorithm,digest=expected.split('-',1)
    assert algorithm=='sha512' and base64.b64encode(hashlib.sha512(archive).digest()).decode()==digest
    target=root/'node_modules'/name
    target.mkdir(parents=True,exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(archive),mode='r:gz') as tar:
        for member in tar.getmembers():
            assert member.name.startswith('package/') and not member.issym() and not member.islnk()
            dest=(target/member.name[len('package/'):]).resolve()
            assert dest.is_relative_to(target.resolve()) and member.size<50*1024*1024
            if member.isdir():dest.mkdir(exist_ok=True,parents=True)
            elif member.isfile():
                dest.parent.mkdir(exist_ok=True,parents=True)
                dest.write_bytes(tar.extractfile(member).read())
            else:raise ValueError('Unsupported archive entry')
    evidence['packages'].append({'name':name,'version':metadata['version'],'tarball':metadata['dist']['tarball'],'integrity':expected,'verified':True})
    print(json.dumps({'downloaded':name,'bytes':len(archive),'integrity':'verified'}),flush=True)
page=get('https://github.com/meilisearch/meilisearch/releases/expanded_assets/v1.54.3').decode()
name='meilisearch-windows-amd64.exe'
tag=re.search(r'<clipboard-copy[^>]*aria-label="Copy to clipboard digest for '+re.escape(name)+r'"[^>]*>',page).group(0)
expected=re.search(r'value="sha256:([a-f0-9]{64})"',tag).group(1)
url='https://github.com/meilisearch/meilisearch/releases/download/v1.54.3/'+name
binary=root/'meilisearch.exe'
if not binary.exists() or hashlib.sha256(binary.read_bytes()).hexdigest()!=expected:
    data=get(url)
    assert hashlib.sha256(data).hexdigest()==expected
    binary.write_bytes(data)
evidence['meilisearch']={'version':'1.54.3','download':url,'sha256':expected,'bytes':binary.stat().st_size,'officialDigestMatched':True}
(root/'provenance.json').write_text(json.dumps(evidence,indent=2),encoding='utf-8')
print(json.dumps(evidence),flush=True)
