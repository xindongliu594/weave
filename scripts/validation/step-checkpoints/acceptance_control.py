"""Install/remove temporary scoped test controls; reuse existing accounting and executor."""
import hashlib,json,os,pathlib,subprocess,sys,time
from acceptance import Acceptance

SERVICE='weiwu-jj.service'
BASE=pathlib.Path('/home/jj/.local/share/weiwu')
TARGETS=['scripts/local-api.ts','apps/api/src/cost-control.ts']
def sha(data):return hashlib.sha256(data).hexdigest()

def patches(originals,release,root,state):
    anchor=' const prepared=prepareCompletionRequest(model,messages,maxTokens,request);'
    source=originals[TARGETS[1]].decode();assert source.count(anchor)==1,'Source changed: do not patch by guess'
    bootstrap='''import {existsSync,readFileSync,openSync,writeSync,fsyncSync,closeSync} from 'node:fs';
import {ProductDshRuntime} from %s;
import {atStepBoundary} from %s;
const statePath=%s, marker=%s, original=ProductDshRuntime.prototype.start;
ProductDshRuntime.prototype.start=function(input){
 const state=JSON.parse(readFileSync(statePath,'utf8'));
 if(state.projectId&&input.approvedSnapshot.projectId===state.projectId&&!this.acceptanceBoundaryInstalled){
  this.acceptanceBoundaryInstalled=true;
  this.beforeRequest=atStepBoundary(this.beforeRequest,{root:%s,projectId:state.projectId,taskId:state.taskIds.qa,command:'node --test cli.test.mjs',onBoundary:record=>{
   if(!existsSync(marker)){const fd=openSync(marker,'wx',0o600);try{writeSync(fd,JSON.stringify(record,null,2));fsyncSync(fd);}finally{closeSync(fd);}}
  }});
 }
 return original.call(this,input);
};
''' % tuple(json.dumps(x) for x in [(release/'services/agent-runtime/product-runtime.mjs').as_uri(),(release/'scripts/validation/step-checkpoints/controlled-step-boundary.mjs').as_uri(),str(root/'state.json'),str(root/'boundary.json'),str(BASE/'data/pilot/runs')])
    expected=state['model']
    guard='''
 if(options.sessionId===%s){
  const {readFileSync,writeFileSync}=await import('node:fs');
  const config=JSON.parse(readFileSync(%s,'utf8'));
  const expected=%s;
  if(config.sessionId!==options.sessionId||model.id!==expected.id||model.version!==expected.version||model.inputRate!==expected.inputRate||model.outputRate!==expected.outputRate)throw Error('Acceptance model/config changed');
  const {assertRemainingCall}=await import(%s);
  const quote=assertRemainingCall(options.sessionId,prepared.body,config);
  writeFileSync(config.quotePath,JSON.stringify({quote,maxTokens,sessionId:options.sessionId}),{flag:'wx',mode:0o600});
 }
''' % tuple(json.dumps(x) for x in ['organization:'+state['conversationId'],str(root/'planning-guard.json'),expected,(release/'scripts/validation/task-driven-organization/remaining-call-budget.mjs').as_uri()])
    return {'files':{TARGETS[0]:('await import('+json.dumps((root/'boundary-bootstrap.mjs').as_uri())+');\n').encode()+originals[TARGETS[0]],TARGETS[1]:source.replace(anchor,anchor+guard).encode()},'bootstrap':bootstrap}

def service(action):subprocess.run(['systemctl','--user',action,SERVICE],check=True)
def health(app):
    for _ in range(50):
        try:
            result=app.api('/health')
            if result['database']=='connected':return result
        except Exception:pass
        time.sleep(.4)
    raise RuntimeError('Service health not ready')

def run(root,mode):
    app=Acceptance(root);root=app.root
    assert root==BASE/'validation/step-acceptance-20261020'
    release=pathlib.Path(subprocess.check_output(['systemctl','--user','show',SERVICE,'--property=WorkingDirectory','--value'],text=True).strip()).resolve()
    assert release.is_relative_to((BASE/'releases').resolve()) and (release/'scripts/validation/step-checkpoints/controlled-step-boundary.mjs').is_file()
    assert all((release/name).resolve().is_relative_to(release) for name in TARGETS)
    record=root/'control-installed.json'
    if mode in ['check','install']:
        assert not record.exists(),'Controls already recorded: inspect, do not reinstall'
        assert not [r for r in app.api('/runs') if r['status'] in ['running','queued']]
        app.money()
        originals={name:(release/name).read_bytes() for name in TARGETS}
        result=patches(originals,release,root,app.s)
        if mode=='check':return {'preflight':True,'release':str(release),'targets':TARGETS,'modelCalls':0}
        assert app.s.get('authorized') is True,'Paid phase allocation not yet authorized'
        saved={name:{'originalSha256':sha(originals[name]),'patchedSha256':sha(result['files'][name]),'backup':str(root/(pathlib.Path(name).name+'.original'))} for name in TARGETS}
        for name in TARGETS:
            with pathlib.Path(saved[name]['backup']).open('xb') as file:file.write(originals[name]);file.flush();os.fsync(file.fileno())
        with (root/'boundary-bootstrap.mjs').open('x',encoding='utf-8') as file:file.write(result['bootstrap'])
        # Persist the restoration recipe before the first service/source mutation.
        # A crash must leave enough information to inspect or restore originals.
        with record.open('x',encoding='utf-8') as file:
            json.dump({'release':str(release),'files':saved},file,indent=2);file.flush();os.fsync(file.fileno())
        service('stop')
        try:
            for name in TARGETS:(release/name).write_bytes(result['files'][name])
            service('start');health(app)
        except Exception:
            service('stop')
            for name in TARGETS:(release/name).write_bytes(originals[name])
            service('start');raise
        return {'installed':True,'release':str(release),'modelCalls':0}
    assert mode in ['restart','remove']
    installed=json.loads(record.read_text());assert installed['release']==str(release)
    for name,proof in installed['files'].items():
        assert sha((release/name).read_bytes())==proof['patchedSha256'] and sha(pathlib.Path(proof['backup']).read_bytes())==proof['originalSha256']
    active=[r for r in app.api('/runs') if r['status'] in ['running','queued']]
    app.money()
    before={'usage':app.api('/usage'),'costs':app.api('/costs')}
    if mode=='restart':
        boundary=json.loads((root/'boundary.json').read_text());rid=app.s['runId']
        assert boundary['runId']==rid and boundary['taskId']==app.s['taskIds']['qa']
        assert len(active)==1 and active[0]['id']==rid
        assert not [o for o in app.api('/runs/'+rid+'/local-operations') if o['status'] in ['queued','claimed','started']]
        run=app.api('/runs/'+rid+'?limit=1');assert not run['recovery']['unknownOperations']
        before.update(run=run,boundary=boundary,artifacts=app.api('/runs/'+rid+'/artifacts'))
    else:assert not active
    with (root/('before-'+mode+'.json')).open('x',encoding='utf-8') as file:json.dump(before,file,ensure_ascii=False,indent=2)
    service('stop')
    for name,proof in installed['files'].items():(release/name).write_bytes(pathlib.Path(proof['backup']).read_bytes())
    service('start');health(app)
    assert app.api('/usage')==before['usage'],'Usage changed across controlled restart'
    assert {c['id']:(c['amount'],c['status']) for c in app.api('/costs')['calls']}=={c['id']:(c['amount'],c['status']) for c in before['costs']['calls']}
    after={'restored':True,'usageUnchanged':True,'unknownFeesUnchanged':True,'money':app.money()}
    if mode=='restart':after['run']=app.api('/runs/'+app.s['runId']+'?limit=1')
    with (root/('after-'+mode+'.json')).open('x',encoding='utf-8') as file:json.dump(after,file,ensure_ascii=False,indent=2)
    return {'restored':True,'status':after.get('run',{}).get('status'),'money':after['money']}

if __name__=='__main__':
    os.umask(0o077);assert len(sys.argv)==3,'Usage: acceptance_control.py ROOT check|install|restart|remove'
    print(json.dumps(run(sys.argv[1],sys.argv[2]),ensure_ascii=False))
