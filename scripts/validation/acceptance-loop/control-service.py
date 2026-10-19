"""Install/remove a project-scoped acceptance stop; no database or delivery edits."""
import hashlib, json, os, pathlib, subprocess, sys, time, urllib.request
os.umask(0o077)
BASE=pathlib.Path('/home/jj/.local/share/weiwu/validation/task-driven-organization-20261018')
ROOT=pathlib.Path('/home/jj/.local/share/weiwu/validation/acceptance-loop-20261019-958b45e')
RELEASE=pathlib.Path('/home/jj/.local/share/weiwu/releases/weiwu-task-organization-20261018')
TARGET=RELEASE/'scripts/local-api.ts'
BACKUP=ROOT/'local-api.original.ts'
def get(route):
    with urllib.request.urlopen('http://127.0.0.1:4310/api/'+route,timeout=15) as r:return json.load(r)
def save(name,value):
    with (ROOT/name).open('x') as f:json.dump(value,f,ensure_ascii=False,indent=2)
def service(action):subprocess.run(['systemctl','--user',action,'weiwu-jj.service'],check=True)
def health():
    for _ in range(50):
        try:
            h=get('health')
            if h['database']=='connected':return h
        except Exception:pass
        time.sleep(.4)
    raise RuntimeError('service health not ready')
def sha(x):return hashlib.sha256(x).hexdigest()
state=json.loads((ROOT/'state.json').read_text())
mode=sys.argv[1]
if mode=='install':
    assert not [r for r in get('runs') if r['status'] in ['running','queued']]
    assert not BACKUP.exists()
    original=TARGET.read_bytes(); BACKUP.write_bytes(original)
    bootstrap=ROOT/'boundary-bootstrap.mjs'
    bootstrap.write_text('''import {existsSync,writeFileSync} from 'node:fs';
import {ProductDshRuntime} from %s;
import {readRun} from %s;
import {atAcceptedBoundary} from %s;
const projectId=%s, marker=%s, original=ProductDshRuntime.prototype.start;
ProductDshRuntime.prototype.start=function(input){
 if(input.approvedSnapshot.projectId===projectId&&!this.acceptanceBoundaryInstalled){
  this.acceptanceBoundaryInstalled=true;
  this.beforeRequest=atAcceptedBoundary(this.beforeRequest,{projectId,taskId:%s,read:id=>readRun(%s,id),onBoundary:record=>{if(!existsSync(marker))writeFileSync(marker,JSON.stringify(record,null,2),{flag:'wx',mode:0o600});}});
 }
 return original.call(this,input);
};
''' % tuple(json.dumps(x) for x in [(RELEASE/'services/agent-runtime/product-runtime.mjs').as_uri(),(RELEASE/'services/agent-runtime/trace-store.mjs').as_uri(),(BASE/'controlled-boundary.mjs').as_uri(),state['projectId'],str(ROOT/'boundary.json'),state['developerTaskId'],'/home/jj/.local/share/weiwu/data/pilot/runs']))
    patched=('await import('+json.dumps(bootstrap.as_uri())+');\n').encode()+original
    service('stop')
    try:
        TARGET.write_bytes(patched);service('start');h=health()
    except Exception:
        service('stop');TARGET.write_bytes(original);service('start');raise
    save('control-installed.json',{'projectId':state['projectId'],'originalSha256':sha(original),'patchedSha256':sha(patched),'health':h,'scope':'hold next request only after selected writer accepted; no response substitution'})
    print(json.dumps({'installed':True,'projectId':state['projectId']}))
elif mode=='restart':
    control=json.loads((ROOT/'control-installed.json').read_text());boundary=json.loads((ROOT/'boundary.json').read_text())
    assert boundary['runId']==state['runId']
    assert sha(TARGET.read_bytes())==control['patchedSha256'] and sha(BACKUP.read_bytes())==control['originalSha256']
    run=get('runs/'+state['runId']+'?limit=1');costs=get('costs');usage=get('usage')
    assert run['status']=='running' and not run['recovery']['unknownOperations']
    assert all(c['status']=='uncertain' and c['id'] in {x['id'] for x in state['baselineUnknown']} for c in costs['calls'])
    assert not [r for r in get('runs') if r['status'] in ['running','queued'] and r['id']!=state['runId']]
    operations=get('runs/'+state['runId']+'/local-operations')
    assert not [o for o in operations if o['status'] in ['queued','claimed','started']]
    artifacts=get('runs/'+state['runId']+'/artifacts')
    save('before-restart.json',{'run':run,'usage':usage,'costs':costs,'boundary':boundary,'operations':operations,'artifacts':artifacts})
    service('stop')
    TARGET.write_bytes(BACKUP.read_bytes()); service('start');h=health()
    after=get('runs/'+state['runId']+'?limit=1')
    save('after-restart.json',{'run':after,'usage':get('usage'),'costs':get('costs'),'health':h,'restoredSourceSha256':sha(TARGET.read_bytes())})
    assert sha(TARGET.read_bytes())==control['originalSha256']
    print(json.dumps({'restarted':True,'parentStatus':after['status'],'error':after.get('error'),'originalSourceRestored':True},ensure_ascii=False))
else:raise RuntimeError('Unknown mode')
