class BudgetedLLM:
 """SkillX's injected LLM protocol; all transport and accounting stay in the host."""
 def __init__(self,send):self.send=send;self.failed=False;self.calls=0
 async def ainvoke(self,messages,regex_pattern=None,regex_extractor=None,**kwargs):
  if self.failed:raise ValueError('PILOT_STOPPED: earlier request or parsing failed; do not replay')
  try:
   if not messages or self.calls>=3:raise ValueError('PILOT_REQUEST_LIMIT')
   normalized=[]
   for message in messages:
    role,content=message if isinstance(message,tuple) else (message.type,message.content)
    role={'human':'user','ai':'assistant'}.get(role,role)
    if role not in ['system','user','assistant'] or not isinstance(content,str):raise ValueError('PILOT_MESSAGE_INVALID')
    normalized.append({'role':role,'content':content})
   stage=['extract','general-filter','tool-filter'][self.calls];self.calls+=1
   result=await self.send({'stage':stage,'messages':normalized})
   if not result.get('usageId') or not isinstance(result.get('text'),str):raise ValueError('PILOT_RECEIPT_MISSING')
   text=result['text']
   if regex_extractor:
    value=regex_extractor(text)
    if not value or isinstance(value,list) and len(value)!=1:raise ValueError('PILOT_EXTRACTION_INVALID')
   if regex_pattern:
    import re
    if not re.search(regex_pattern,text):raise ValueError('PILOT_OUTPUT_INVALID')
   return text
  except Exception:
   self.failed=True;raise
