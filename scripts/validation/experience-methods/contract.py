"""Structural grounding checks; semantic correctness still needs independent review."""
import json,re
SECTIONS={'applicability':'适用条件','steps':'操作步骤','limitations':'限制与注意事项','counterexamples':'反例与失败条件','verification':'验收方法'}
CHECKS={'grounded','bounded','useful','preservesFindings','doesNotInventTools'}
def parse_extraction(text):
 if not isinstance(text,str):return None
 text=text.strip()
 if text.startswith('```json\n') and text.endswith('\n```'):text=text[8:-4]
 try:value=json.loads(text)
 except ValueError:return None
 return value if isinstance(value,list) and len(value)==1 and isinstance(value[0],dict) and set(value[0])=={'option','skill'} and value[0]['option']=='add' else None
def original_method(original,accepted):
 if set(accepted)-set(original)-{'metadata'} or any(accepted.get(k)!=v for k,v in original.items()):raise ValueError('UPSTREAM_METHOD_CHANGED')
 return original
def validate_method(skill,schemas,fields,sources):
 def fail():raise ValueError('EXPERIENCE_CONTRACT_INVALID')
 if not isinstance(skill,dict) or set(skill)!={'name','document','content','tools'}:fail()
 if not isinstance(skill['name'],str) or not re.fullmatch('[a-z0-9-]{3,80}',skill['name']):fail()
 if not isinstance(skill['document'],str) or not 1<=len(skill['document'])<=500:fail()
 if not isinstance(skill['content'],str) or len(skill['content'])>16000:fail()
 try:body=json.loads(skill['content'])
 except (TypeError,ValueError):fail()
 if not isinstance(body,dict) or set(body)!=set(SECTIONS):fail()
 if not isinstance(skill['tools'],list) or not skill['tools'] or any(not isinstance(t,str) or t not in schemas for t in skill['tools']):fail()
 used=set()
 for section,items in body.items():
  if not isinstance(items,list) or not 1<=len(items)<=8:fail()
  for item in items:
   keys={'text','sources'}|({'tool','arguments','resultFields'} if section=='steps' else set())
   if not isinstance(item,dict) or set(item)!=keys:fail()
   if not isinstance(item['text'],str) or not 1<=len(item['text'])<=1000 or re.search(r'```|^\s*(?:import |from \w+ import |def |class )|\b(?:exec|eval)\s*\(',item['text'],re.M):fail()
   if not isinstance(item['sources'],list) or not item['sources'] or any(not isinstance(ref,str) or ref not in sources for ref in item['sources']):fail()
   if section=='steps':
    tool=item['tool'];args=item['arguments'];out=item['resultFields']
    if not isinstance(args,list) or not isinstance(out,list) or any(not isinstance(x,str) for x in args+out):fail()
    if tool is None:
     if args or out:fail()
    else:
     if not isinstance(tool,str) or tool not in schemas:fail()
     used.add(tool);parameters=schemas[tool]['parameters']
     if not set(parameters.get('required',[]))<=set(args) or not set(args)<=set(parameters['properties']) or not set(out)<=set(fields[tool]):fail()
 if set(skill['tools'])!=used:fail()
 return body

def review_passed(text,required_sources):
 try:
  review=json.loads(text)
  return (isinstance(review,dict) and set(review)=={'verdict','findings','checkedSources','checks'} and review['verdict']=='pass'
   and review['findings']==[] and isinstance(review['checkedSources'],list) and all(isinstance(v,str) for v in review['checkedSources'])
   and set(review['checkedSources'])==set(required_sources) and isinstance(review['checks'],dict) and set(review['checks'])==CHECKS
   and all(value is True for value in review['checks'].values()))
 except (TypeError,ValueError):return False

def render_method(skill,body,sources,run_id):
 lines=['# '+skill['name'],'',skill['document'],'','状态：待跨任务试用；来源工作成功不代表本方法已证明泛化或提速。']
 for key,title in SECTIONS.items():
  lines+=['','## '+title]
  for item in body[key]:
   lines.append('- '+item['text']+' '+''.join('['+ref+']' for ref in item['sources']))
   if key=='steps' and item['tool']:lines.append('  工具：'+item['tool']+'；参数：'+', '.join(item['arguments'])+'；读取字段：'+', '.join(item['resultFields']))
 lines+=['','## 固定证据','来源运行：'+run_id]
 for ref,source in sources.items():lines.append('- '+ref+'：'+json.dumps(source,ensure_ascii=False,sort_keys=True))
 return '\n'.join(lines)+'\n'
