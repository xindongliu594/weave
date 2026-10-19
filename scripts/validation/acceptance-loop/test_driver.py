"""Local harness tests; these fixtures are not model or employee acceptance evidence."""
import copy, unittest
from driver import validate_case

def fixture():
    return {'orchestration':{'pattern':'pipeline'},'agents':[{'id':i} for i in ['dev-1','qa-1','mgr-1']], 'tasks':[
        {'id':'d','assigneeId':'dev-1','kind':'implementation','dependencies':[],'inputs':[],'outputs':[{'path':'cli.mjs'},{'path':'README.md'}],'verify':['node --check cli.mjs']},
        {'id':'q','assigneeId':'qa-1','kind':'verification','dependencies':['d'],'inputs':[{'path':'cli.mjs','producerTaskId':'d'},{'path':'README.md','producerTaskId':'d'}],'outputs':[{'path':'cli.test.mjs'}],'verify':['node --test cli.test.mjs'],'acceptanceChecks':[{'criterionIndex':0,'command':'node --test cli.test.mjs','minimumTests':7,'expectedExitCode':0}]},
        {'id':'m','assigneeId':'mgr-1','kind':'review','reviewedTaskId':'d','dependencies':['d','q'],'inputs':[{'path':'cli.mjs','producerTaskId':'d'},{'path':'README.md','producerTaskId':'d'},{'path':'cli.test.mjs','producerTaskId':'q'}],'outputs':[]}],
        'deliveryCriteria':[{'producerTaskIds':['d'],'checkTaskId':'q','checkCriteriaIndexes':[0],'independent':True}]}

class CaseTest(unittest.TestCase):
    def test_exact_case_passes(self):self.assertEqual(validate_case(fixture()),'d')
    def test_off_case_is_rejected(self):
        edits=[lambda p:p['tasks'][1].update(assigneeId='dev-1'),lambda p:p['tasks'][2].update(kind='work'),lambda p:p['tasks'][2].update(maxReworkRounds=1),lambda p:p['tasks'][0].update(verify=['node --test cli.test.mjs']),lambda p:p['tasks'][1].update(outputs=[{'path':'cli.mjs'}]),lambda p:p['tasks'][1]['acceptanceChecks'][0].update(minimumTests=1),lambda p:p['tasks'][2].update(inputs=[]),lambda p:p['deliveryCriteria'][0].update(independent=False)]
        for edit in edits:
            with self.subTest(edit=edits.index(edit)):
                p=copy.deepcopy(fixture());edit(p)
                with self.assertRaises(AssertionError):validate_case(p)
if __name__=='__main__':unittest.main()
