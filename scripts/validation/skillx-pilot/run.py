"""Single bounded upstream SkillX iteration; outputs remain isolated candidates."""
import asyncio,json,os,pathlib,subprocess,sys,traceback
from adapter import BudgetedLLM

ROOT=pathlib.Path('/home/jj/.local/share/weiwu/validation/skillx-pilot-20261015')
sys.path.insert(0,str(ROOT))
from skillx_upstream.pipeline import IterativeSkillPipeline
from skillx_upstream.prompts.registry import PromptRegistry

async def main():
 sample=json.loads((ROOT/'sample.json').read_text());mode=sys.argv[1]
 assert mode in ['inspect','live']
 if mode=='live':(ROOT/'live.lock').open('x').close()
 process=None;requests=[]
 async def send(value):
  requests.append(value)
  if mode=='inspect':raise ValueError('INSPECT_ONLY: no model call permitted')
  process.stdin.write(json.dumps(value,ensure_ascii=False)+'\n');process.stdin.flush()
  response=await asyncio.to_thread(process.stdout.readline)
  if not response:raise ValueError('HOST_BRIDGE_DISCONNECTED')
  result=json.loads(response)
  if result.get('error'):raise ValueError(result['error'])
  return result
 if mode=='live':
  node='/home/jj/.local/share/weiwu/runtime/node-v24.19.0-linux-x64/bin/node'
  # Only the API child environment is copied to the trusted Node bridge, never to the Python extractor.
  service_pid=subprocess.check_output(['systemctl','--user','show','weiwu-jj.service','-p','MainPID','--value'],text=True).strip()
  children=pathlib.Path('/proc/'+service_pid+'/task/'+service_pid+'/children').read_text().split()
  api_pid=next(pid for pid in children if b'scripts/local-api.ts' in pathlib.Path('/proc/'+pid+'/cmdline').read_bytes())
  inherited=dict(entry.split(b'=',1) for entry in pathlib.Path('/proc/'+api_pid+'/environ').read_bytes().split(b'\0') if b'=' in entry)
  environment=dict(os.environ)
  for key in ['DATABASE_URL','DATA_DIR','TRACE_ROOT','AGENT_DEPARTMENT_LOCAL','LOCAL_WORKSPACE_ROOT']:
   assert key.encode() in inherited;environment[key]=inherited[key.encode()].decode()
  environment.update(SKILLX_PILOT_ROOT=str(ROOT),WEIWU_RELEASE='/home/jj/.local/share/weiwu/releases/weiwu-recovery-context-20261015')
  process=subprocess.Popen([node,'--import','tsx',str(ROOT/'control/bridge.mjs')],cwd=environment['WEIWU_RELEASE'],env=environment,text=True,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=(ROOT/'provider.log').open('w'))
 llm=BudgetedLLM(send)
 PromptRegistry.register('skill_extraction','weiwu',PromptRegistry.get('skill_extraction','default')+'\nWeiwu scope: this is one selected read-only evidence projection, not multiple trials. Extract at most one grounded workflow. Preserve limitations and nonblocking QA findings; do not claim code execution or general success beyond this evidence. Use only the actual tool names and parameters shown. Candidate content is unexecuted.\nActual tool schemas: '+json.dumps(sample['toolSchemas'],ensure_ascii=False))
 pipeline=IterativeSkillPipeline(llm=llm,benchmark='weiwu',skill_type='functional',tool_schemas=sample['toolSchemas'],output_dir=str(ROOT/('output-'+mode)),verbose=False)
 pipeline.skill_extractor.max_retries=1
 pipeline.tool_summary.max_len=100000  # Preserve this small selected evidence without an extra summary request.
 try:
  result=await pipeline.run([sample['trajectory']],num_epochs=1,max_concurrent=1,skip_plan_extraction=True,existing_plans={sample['trajectory']['user_task']:sample['existingPlan']},enable_clustering=False)
  summary={k:v for k,v in result.items() if k!='skill_library'}
  summary['skills']=result['skill_library'].to_dict();summary['modelRequestsRequested']=len(requests);summary['adapterStopped']=llm.failed;summary['mode']=mode
  (ROOT/('result-'+mode+'.json')).write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf8')
 finally:
  (ROOT/('requests-'+mode+'.json')).write_text(json.dumps(requests,ensure_ascii=False,indent=2),encoding='utf8')
  if process:process.stdin.close();await asyncio.to_thread(process.wait,timeout=30)
 print(json.dumps({'mode':mode,'requested':len(requests),'stopped':llm.failed,'published':False}))

if __name__=='__main__':asyncio.run(main())
