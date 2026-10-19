"""Bound the one remaining authorized planning call before reservation/dispatch.
Temporary acceptance guard only, restore exact service source after the call.
"""
import hashlib,json,os,pathlib,subprocess,sys,time,urllib.request
os.umask(0o077)
BASE=pathlib.Path('/home/jj/.local/share/weiwu/validation/task-driven-organization-20261018')
ROOT=pathlib.Path('/home/jj/.local/share/weiwu/validation/acceptance-loop-20261019-958b45e')
TARGET=pathlib.Path('/home/jj/.local/share/weiwu/releases/weiwu-task-organization-20261018/apps/api/src/cost-control.ts')
BACKUP=ROOT/'cost-control.original.ts'
def get(route):
 with urllib.request.urlopen('http://127.0.0.1:4310/api/'+route,timeout=15) as r:return json.load(r)
def service(action):subprocess.run(['systemctl','--user',action,'weiwu-jj.service'],check=True)
def health():
 for _ in range(50):
  try:
   if get('health')['database']=='connected':return
  except Exception:pass
  time.sleep(.4)
 raise RuntimeError('health not ready')
def sha(b):return hashlib.sha256(b).hexdigest()
s=json.loads((ROOT/'state.json').read_text())
assert not [r for r in get('runs') if r['status'] in ['running','queued']]
mode=sys.argv[1]
correction=len(sys.argv)>2 and sys.argv[2]=='correction'
prefix='correction' if correction else 'planning'
BACKUP=ROOT/(prefix+'-cost-control.original.ts')
if mode in ['install','reinstall-unsent']:
 assert {c['id']:c['amount'] for c in get('costs')['calls']}=={c['id']:c['amount'] for c in s['baselineUnknown']}
 assert ('correct' if correction else 'plan') not in s['requests']
 if mode=='install':assert not BACKUP.exists()
 else:
  assert not (ROOT/(prefix+'-dispatch-quote.json')).exists()
  previous=json.loads((ROOT/(prefix+'-guard-installed.json')).read_text())
  assert sha(TARGET.read_bytes())==sha(BACKUP.read_bytes())==previous['originalSha256']
 model=next(m for m in get('models') if m['id']=='c8a4e6ad-1aaf-43a4-8ba1-d0a6cce59051')
 assert model['version']==7 and model['inputRate']==.3 and model['outputRate']==1.2
 original=TARGET.read_bytes()
 if mode=='install':BACKUP.write_bytes(original)
 from decimal import Decimal
 used=sum(Decimal(str(u['cost'])) for u in get('usage') if u['id'] not in s['baselineUsageIds'])
 assert used<Decimal('.03')
 options={'sessionId':'organization:'+s['conversationId'],'inputRate':.3,'outputRate':1.2,'allowance':float(Decimal('.03')-used)}
 anchor=' const prepared=prepareCompletionRequest(model,messages,maxTokens,request);'
 source=original.decode();assert source.count(anchor)==1
 guard="\n const {assertRemainingCall}=await import("+json.dumps((BASE/'remaining-call-budget.mjs').as_uri())+");\n const quote=assertRemainingCall(options.sessionId,prepared.body,"+json.dumps(options)+");\n if(quote!==undefined){const {writeFileSync}=await import('node:fs');writeFileSync("+json.dumps(str(ROOT/(prefix+'-dispatch-quote.json')))+",JSON.stringify({quote,maxTokens,sessionId:options.sessionId}),{flag:'wx',mode:0o600});}\n"
 patched=source.replace(anchor,anchor+guard).encode()
 if mode=='reinstall-unsent':assert sha(patched)==previous['patchedSha256']
 service('stop')
 try:TARGET.write_bytes(patched);service('start');health()
 except Exception:
  service('stop');TARGET.write_bytes(original);service('start');raise
 record={**options,'originalSha256':sha(original),'patchedSha256':sha(patched),'scope':'one fixed planning session; before reserve, no response substitution'}
 (ROOT/(prefix+'-guard-installed.json')).write_text(json.dumps(record,indent=2));print(json.dumps(record))
elif mode=='restore':
 record=json.loads((ROOT/(prefix+'-guard-installed.json')).read_text())
 if not BACKUP.exists() and not correction:BACKUP=ROOT/'cost-control.original.ts'
 assert sha(TARGET.read_bytes())==record['patchedSha256'] and sha(BACKUP.read_bytes())==record['originalSha256']
 service('stop');TARGET.write_bytes(BACKUP.read_bytes());service('start');health()
 (ROOT/(prefix+'-guard-restored.json')).write_text(json.dumps({'restored':True,'sha256':sha(TARGET.read_bytes())}))
 print('{"restored":true}')
else:raise RuntimeError('Unknown mode')
