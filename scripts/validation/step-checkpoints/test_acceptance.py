"""Harness tests only; never real employee or model acceptance evidence."""
import copy, pathlib, sys, unittest
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'acceptance-loop'))
from test_driver import fixture
try:
    from acceptance import validate_checkpoint_case, totals
except ImportError:
    validate_checkpoint_case = totals = None

class CheckpointCaseTest(unittest.TestCase):
    def candidate(self):
        plan=fixture()
        plan['tasks'][1]['verificationReuse']='same-workspace'
        return plan

    def test_independent_case_and_opt_in_are_required(self):
        self.assertTrue(callable(validate_checkpoint_case))
        plan=self.candidate()
        self.assertEqual(validate_checkpoint_case(plan),{'developer':'d','qa':'q','manager':'m'})
        for edit in [lambda p:p['tasks'][1].pop('verificationReuse'),
                     lambda p:p['tasks'][1].update(verificationReuse='never'),
                     lambda p:p['tasks'][1].update(assigneeId='dev-1'),
                     lambda p:p['tasks'][2].update(verify=['node --test cli.test.mjs']),
                     lambda p:p['agents'][0].update(tools=['terminal']),
                     lambda p:p['tasks'][0].update(maxBudget=0.16)]:
            changed=copy.deepcopy(plan);edit(changed)
            with self.assertRaises(AssertionError):validate_checkpoint_case(changed)

    def test_unknown_holds_and_float_tails_do_not_reset_the_budget(self):
        self.assertTrue(callable(totals))
        usage=[{'id':'old','cost':3.1380507},{'id':'new','cost':0.01}]
        holds=[{'id':'old-hold','status':'uncertain','amount':0.0824102}]
        state={'baselineUsageIds':['old'],'baselineUnknown':holds}
        self.assertEqual(totals(state,usage[:1],holds)['phaseSpent'],0)
        result=totals(state,usage,holds)
        self.assertEqual(result['occupied'],3.2304609)
        self.assertEqual(result['phaseSpent'],0.01)
        with self.assertRaises(AssertionError):totals(state,usage,[])
        with self.assertRaises(AssertionError):totals(state,usage+[{'id':'over','cost':.18}],holds)
        with self.assertRaises(AssertionError):totals(state,usage,holds+[{'id':'new-hold','status':'uncertain','amount':.01}])

if __name__=='__main__':unittest.main()
