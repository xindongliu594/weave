"""Synthetic evidence only: verify the auditor rejects contradictory records."""
import copy,importlib.util,json,pathlib,tempfile,unittest
path=pathlib.Path(__file__).resolve().parents[2]/'scripts/validation/skillx-pilot/audit.py'
spec=importlib.util.spec_from_file_location('pilot_audit',path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

def evidence():
 before={'sourceRunId':'source','status':'completed','integrity':'ok','shareable':True,'snapshotSHA':'snap','eventsSHA':'events','files':[{'sha256':'file'}],'holds':[{'id':'old','amount':.01}],'occupied':1.,'usageCount':7}
 after={**copy.deepcopy(before),'occupied':1.002,'usageCount':8,'pendingCount':0,'preserved':{'snapshot':True,'events':True,'files':True,'oldHolds':True},'trialUsage':[{'id':'receipt','inputTokens':10,'outputTokens':1,'cost':.002}]}
 return {'before.json':before,'after.json':after,'result-live.json':{'modelRequestsRequested':1,'final_skills_count':0,'skills':{'skills':{'functional':[],'planning':{},'atomic':[]}},'epochs':[{'extracted_skills':[],'filtered_skills':[]}]},
 'sample.json':{'sourceRunId':'source','trajectory':{'metadata':{'eventSeqs':[1,2]},'task_history':[]}},
 'call-1.json':{'stage':'general-filter','status':'returned','finishReason':'stop','usageId':'receipt','text':'bad'},'setup-result.json':{'commit':'fixture'}}

class AuditTests(unittest.TestCase):
 def run_audit(self,files):
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d)
   for name,value in files.items():(root/name).write_text(json.dumps(value),encoding='utf8')
   return module.audit(root)
 def test_rejects_changed_evidence_even_when_saved_preserved_flags_are_true(self):
  mutations=[lambda f:f['after.json'].update(sourceRunId='other'),lambda f:f['after.json'].update(snapshotSHA='other'),lambda f:f['after.json'].update(eventsSHA='other'),lambda f:f['after.json'].update(files=[]),lambda f:f['after.json'].update(holds=[])]
  for mutate in mutations:
   with self.subTest(mutate=mutate):
    files=evidence();mutate(files)
    with self.assertRaises(AssertionError):self.run_audit(files)
 def test_rejects_candidate_count_or_filter_contradiction(self):
  mutations=[lambda f:f['result-live.json'].update(final_skills_count=1),lambda f:f['result-live.json']['skills']['skills'].update(functional=[{}]),lambda f:f['result-live.json']['epochs'][0].update(filtered_skills=[{}]),lambda f:f['call-1.json'].update(text='good')]
  for mutate in mutations:
   with self.subTest(mutate=mutate):
    files=evidence();mutate(files)
    with self.assertRaises(AssertionError):self.run_audit(files)
 def test_consistent_rejected_evidence_is_reported(self):
  self.assertEqual(self.run_audit(evidence())['qualityConclusion'],'rejected; not ready for reuse')

if __name__=='__main__':unittest.main()
