"""SkillX document-mode adaptation. No generated code execution or automatic publication."""
import asyncio,copy,hashlib,json,os,pathlib,subprocess,sys
from contract import validate_method,review_passed,render_method,parse_extraction,original_method
from prompts import extraction_prompt,review_prompt
ROOT=pathlib.Path('/home/jj/.local/share/weiwu/validation/experience-methods-20261015')
UPSTREAM=pathlib.Path('/home/jj/.local/share/weiwu/validation/skillx-pilot-20261015')
sys.path.insert(0,str(UPSTREAM));sys.path.insert(0,str(UPSTREAM/'control'))
from skillx_upstream.pipeline import IterativeSkillPipeline
from skillx_upstream.prompts.registry import PromptRegistry
from skillx_upstream.filtering.base import ToolSchemaFilter
from skillx_upstream.extraction.skill_extractor import FunctionalSkillExtractor
from adapter import BudgetedLLM

async def main():
 mode=sys.argv[1];assert mode in ['inspect','live','resume-review','export']
 sample=json.loads((UPSTREAM/'sample.json').read_text());trajectory=copy.deepcopy(sample['trajectory'])
 evidence={f'E{i+1}':step for i,step in enumerate(sample['trajectory']['task_history'])}
 sources={ref:step['source'] for ref,step in evidence.items()}
 fields={step['name']:list(json.loads(step['content'])) for step in evidence.values() if step['role']=='tool'}
 for i,step in enumerate(trajectory['task_history']):step['content']='[E'+str(i+1)+']\n'+step['content']
 schemas=sample['toolSchemas'];requests=[];process=None
 def export(result):
  if result['final_skills_count']!=1:raise ValueError('NO_ACCEPTED_METHOD')
  first=json.loads((ROOT/'call-1.json').read_text());review=json.loads((ROOT/'call-2.json').read_text())
  if first['status']!='returned' or review['status']!='returned' or not review_passed(review['text'],set(sources)):raise ValueError('REVIEW_NOT_PASSED')
  original=parse_extraction(first['text'])[0]['skill']
  skill=original_method(original,result['epochs'][0]['filtered_skills'][0]['skill']);body=validate_method(skill,schemas,fields,sources)
  text=render_method(skill,body,sources,sample['sourceRunId'])
  (ROOT/'method.md').write_text(text,encoding='utf8')
  (ROOT/'method.json').write_text(json.dumps({'sourceRunId':sample['sourceRunId'],'skill':skill,'body':body,'sources':sources,'sha256':hashlib.sha256(text.encode()).hexdigest(),'receiptIds':[first['usageId'],review['usageId']],'independentReviewPassed':True,'crossTaskVerified':False},ensure_ascii=False,indent=2))
 if mode=='export':
  export(json.loads((ROOT/'result-resume-review.json').read_text()));print(json.dumps({'exported':True,'modelCalls':0}));return
 if mode in ['live','resume-review']:
  (ROOT/(mode+'.lock')).open('x').close()
  pid=subprocess.check_output(['systemctl','--user','show','weiwu-jj.service','-p','MainPID','--value'],text=True).strip()
  children=pathlib.Path('/proc/'+pid+'/task/'+pid+'/children').read_text().split()
  api_pid=next(child for child in children if b'scripts/local-api.ts' in pathlib.Path('/proc/'+child+'/cmdline').read_bytes())
  private=dict(entry.split(b'=',1) for entry in pathlib.Path('/proc/'+api_pid+'/environ').read_bytes().split(b'\0') if b'=' in entry)
  environment=dict(os.environ)
  for key in ['DATABASE_URL','DATA_DIR','TRACE_ROOT','AGENT_DEPARTMENT_LOCAL','LOCAL_WORKSPACE_ROOT']:environment[key]=private[key.encode()].decode()
  process=subprocess.Popen(['/home/jj/.local/share/weiwu/runtime/node-v24.19.0-linux-x64/bin/node','--import','tsx',str(ROOT/'control/bridge.mjs'),mode],cwd='/home/jj/.local/share/weiwu/releases/weiwu-recovery-context-20261015',env=environment,text=True,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=(ROOT/('provider-'+mode+'.log')).open('w'))
 async def send(value):
  requests.append(value)
  if mode=='inspect':raise ValueError('INSPECT_ONLY')
  if mode=='resume-review' and value['stage']=='extract':
   saved=json.loads((ROOT/'call-1.json').read_text())
   if saved['status']!='returned' or saved['finishReason']!='stop' or saved['stage']!='extract':raise ValueError('NO_KNOWN_EXTRACTION_RESPONSE')
   # Reparse the original billed response locally; never replay its external operation.
   return {'text':saved['text'],'usageId':saved['usageId']}
  if value['stage'] not in ['extract','general-filter']:raise ValueError('NO_THIRD_MODEL_CALL')
  process.stdin.write(json.dumps(value,ensure_ascii=False)+'\n');process.stdin.flush()
  line=await asyncio.to_thread(process.stdout.readline)
  if not line:raise ValueError('PROVIDER_DISCONNECTED')
  result=json.loads(line)
  if result.get('error'):raise ValueError(result['error'])
  return result
 class DocumentLLM(BudgetedLLM):
  async def ainvoke(self,*args,**kwargs):
   stage=self.calls
   text=await super().ainvoke(*args,**kwargs)
   if stage==0:
    try:
     extracted=kwargs['regex_extractor'](text)
     validate_method(extracted[0]['skill'],schemas,fields,sources)
    except Exception:
     self.failed=True;raise
   elif stage==1:
    # The raw response/receipt remain intact; only the upstream boolean adapter gets this label.
    return 'good' if review_passed(text,set(sources)) else 'bad'
   return text
 class StructureFilter(ToolSchemaFilter):
  async def filter(self,skill,**kwargs):
   validate_method(skill.get('skill',skill),schemas,fields,sources)
   return True
 class DocumentExtractor(FunctionalSkillExtractor):
  def _extract_skills_from_response(self,text):return parse_extraction(text)
 llm=DocumentLLM(send)
 PromptRegistry.register('skill_extraction','weiwu-document',extraction_prompt(schemas,fields,sources))
 PromptRegistry.register('general_filter','weiwu-document',review_prompt(evidence,schemas,fields))
 pipeline=IterativeSkillPipeline(llm=llm,benchmark='weiwu-document',skill_type='functional',tool_schemas=schemas,output_dir=str(ROOT/('output-'+mode)),verbose=False)
 pipeline.skill_extractor=DocumentExtractor(llm=llm,benchmark='weiwu-document',max_retries=1,verbose=False);pipeline.tool_summary.max_len=100000
 pipeline.filter_pipeline.tool_filter=StructureFilter(llm=llm,tool_schemas=schemas,verbose=False)
 try:
  result=await pipeline.run([trajectory],num_epochs=1,max_concurrent=1,skip_plan_extraction=True,existing_plans={trajectory['user_task']:sample['existingPlan']},enable_clustering=False)
  summary={key:value for key,value in result.items() if key!='skill_library'}
  summary.update(skills=result['skill_library'].to_dict(),modelRequestsRequested=len(requests),adapterStopped=llm.failed,mode=mode)
  (ROOT/('result-'+mode+'.json')).write_text(json.dumps(summary,ensure_ascii=False,indent=2))
  if mode!='inspect' and result['final_skills_count']==1 and not llm.failed:
   export(result)
  print(json.dumps({'mode':mode,'requests':len(requests),'accepted':result['final_skills_count'],'stopped':llm.failed,'published':False}))
 finally:
  (ROOT/('requests-'+mode+'.json')).write_text(json.dumps(requests,ensure_ascii=False,indent=2))
  if process:process.stdin.close();await asyncio.to_thread(process.wait,timeout=30)

if __name__=='__main__':asyncio.run(main())
