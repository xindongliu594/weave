import asyncio,importlib.util,pathlib,unittest
path=pathlib.Path(__file__).resolve().parents[2]/'scripts/validation/skillx-pilot/adapter.py'
spec=importlib.util.spec_from_file_location('pilot_adapter',path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

def immediate(coro):
 # The injected fake sender completes synchronously; these protocol checks need no OS event loop.
 try:coro.send(None)
 except StopIteration as done:return done.value
 finally:coro.close()

class AdapterTests(unittest.TestCase):
 def test_real_text_passes_through_and_human_role_is_normalized(self):
  sent=[]
  async def send(value):sent.append(value);return {'text':'model generated text','usageId':'receipt'}
  adapter=module.BudgetedLLM(send)
  result=immediate(adapter.ainvoke([('system','rules'),('human','evidence')]))
  self.assertEqual(result,'model generated text');self.assertEqual(sent[0]['messages'][1]['role'],'user')
 def test_invalid_extraction_stops_later_attempts_without_replay(self):
  sent=[]
  async def send(value):sent.append(value);return {'text':'bad output','usageId':'receipt'}
  adapter=module.BudgetedLLM(send)
  with self.assertRaises(ValueError):immediate(adapter.ainvoke([('human','evidence')],regex_extractor=lambda _:None))
  with self.assertRaises(ValueError):immediate(adapter.ainvoke([('human','evidence')]))
  self.assertEqual(len(sent),1)
 def test_multiple_skills_or_empty_messages_are_not_silently_truncated(self):
  async def send(value):return {'text':'two skills','usageId':'receipt'}
  with self.assertRaises(ValueError):immediate(module.BudgetedLLM(send).ainvoke([('human','evidence')],regex_extractor=lambda _:[{},{}]))
  with self.assertRaises(ValueError):immediate(module.BudgetedLLM(send).ainvoke([]))

if __name__=='__main__':unittest.main()
