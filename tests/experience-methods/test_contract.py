import copy,importlib.util,json,pathlib,unittest
path=pathlib.Path(__file__).resolve().parents[2]/'scripts/validation/experience-methods/contract.py'
spec=importlib.util.spec_from_file_location('experience_contract',path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
SCHEMAS={'filesystem':{'parameters':{'properties':{'path':{}},'required':['path']}}}
FIELDS={'filesystem':['path','sha256','content']}
SOURCES={'E1':{'eventSeq':1},'E2':{'eventSeq':2}}
def candidate():
 item={'text':'Synthetic contract fixture; not a real extracted method.','sources':['E1']}
 body={key:[copy.deepcopy(item)] for key in ['applicability','steps','limitations','counterexamples','verification']}
 body['steps'][0].update(tool='filesystem',arguments=['path'],resultFields=['content','sha256'])
 return {'name':'fixture-method','document':'Synthetic test only','tools':['filesystem'],'content':json.dumps(body)}
class ContractTests(unittest.TestCase):
 def test_upstream_metadata_does_not_change_the_original_model_method(self):
  original=candidate();accepted={**original,'metadata':{'skill_type':'functional'}}
  self.assertEqual(m.original_method(original,accepted),original)
  for change in [{'document':'changed'},{'extra':'unknown'}]:
   with self.assertRaises(ValueError):m.original_method(original,{**accepted,**change})
 def test_complete_nested_json_response_is_not_cut_at_inner_array(self):
  raw=json.dumps([{'option':'add','skill':candidate()}],ensure_ascii=False)
  self.assertEqual(m.parse_extraction(raw)[0]['skill']['name'],'fixture-method')
  self.assertEqual(m.parse_extraction('```json\n'+raw+'\n```')[0]['option'],'add')
  self.assertIsNone(m.parse_extraction(raw[:-3]));self.assertIsNone(m.parse_extraction(raw+' trailing text'))
 def test_valid_document_keeps_model_text_and_source_references(self):
  body=m.validate_method(candidate(),SCHEMAS,FIELDS,SOURCES)
  rendered=m.render_method(candidate(),body,SOURCES,'run-fixture')
  self.assertIn('Synthetic contract fixture',rendered);self.assertIn('E1',rendered);self.assertIn('run-fixture',rendered)
 def test_missing_evidence_or_sections_and_code_are_rejected(self):
  mutations=[lambda b:b['steps'][0].update(sources=['FAKE']),lambda b:b['steps'][0].update(sources=[]),lambda b:b.pop('limitations'),lambda b:b.update(counterexamples=[]),lambda b:b['steps'][0].update(text='```python\nexec(secret)\n```')]
  for mutate in mutations:
   with self.subTest(mutate=mutate):
    skill=candidate();body=json.loads(skill['content']);mutate(body);skill['content']=json.dumps(body)
    with self.assertRaises(ValueError):m.validate_method(skill,SCHEMAS,FIELDS,SOURCES)
 def test_unknown_tool_argument_or_result_field_is_rejected(self):
  for patch in [{'tool':'terminal_test'},{'arguments':['filename']},{'arguments':[]},{'resultFields':['size']}]:
   with self.subTest(patch=patch):
    skill=candidate();body=json.loads(skill['content']);body['steps'][0].update(patch);skill['content']=json.dumps(body)
    with self.assertRaises(ValueError):m.validate_method(skill,SCHEMAS,FIELDS,SOURCES)
 def test_review_requires_exact_positive_verdict_and_all_checks(self):
  good={'verdict':'pass','findings':[],'checkedSources':['E1'],'checks':{k:True for k in ['grounded','bounded','useful','preservesFindings','doesNotInventTools']}}
  self.assertTrue(m.review_passed(json.dumps(good),{'E1'}))
  for patch in [{'verdict':'not good'},{'findings':['missing evidence']},{'checkedSources':[]},{'checks':{}}]:
   self.assertFalse(m.review_passed(json.dumps({**good,**patch}),{'E1'}))
  self.assertFalse(m.review_passed('not good',{'E1'}))

if __name__=='__main__':unittest.main()
