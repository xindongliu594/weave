"""Harness tests only; never real employee or model acceptance evidence."""
import copy, pathlib, sys, tempfile, unittest
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'acceptance-loop'))
from test_driver import fixture
try:
    from acceptance import Acceptance, validate_checkpoint_case, totals
except ImportError:
    validate_checkpoint_case = totals = None

class CheckpointCaseTest(unittest.TestCase):
    def test_redistribution_is_explicit_and_a_dispatched_quote_blocks_another_call(self):
        with tempfile.TemporaryDirectory() as temp:
            app=Acceptance(temp)
            app.s={'requests':{}}
            with self.assertRaises(AssertionError):app.planning_request(final=True)
            app.s['planningRedistribution']={'approved':True,'planning':0.05,'execution':0.13,'remainingModelCalls':1}
            app.s['requests']={'revised-plan':{'status':'returned','body':{'messages':[{'role':'user','content':'requirement'}]},'result':{'reply':'draft','draftIssue':{'code':'INVALID','message':'wrong check'}}},'revised-correct':{'status':'http_error','result':{'httpStatus':500}}}
            (app.root/'controls-v2').mkdir();(app.root/'controls-v2/after-remove.json').write_text('{"restored":true,"usageUnchanged":true,"unknownFeesUnchanged":true}')
            label,messages,_=app.planning_request(final=True);self.assertEqual(label,'final-plan');self.assertIn('$0.13',messages[-1]['content'])
            self.assertEqual(sum(app.limits()),__import__('decimal').Decimal('.18'))
            (app.root/'revised-correct-quote.json').write_text('{}')
            with self.assertRaises(AssertionError):app.planning_request(final=True)

    def test_continuation_requires_extra_call_approval_and_preserves_prior_history(self):
        with tempfile.TemporaryDirectory() as temp:
            app=Acceptance(temp)
            first={'role':'user','content':'original requirement'}
            returned={'status':'returned','body':{'messages':[first]},'result':{'reply':'failed','draftIssue':{'code':'INVALID','message':'missing field'}}}
            app.s={'requests':{'plan':copy.deepcopy(returned),'correct':copy.deepcopy(returned)}}
            with self.assertRaises(AssertionError):app.planning_request(revised=True)
            app.s['planningContinuation']={'approved':True,'maxExtraCalls':2,'maxPlanningCost':0.03}
            with self.assertRaises(AssertionError):app.planning_request(revised=True)
            (app.root/'after-remove.json').write_text('{}')
            with self.assertRaises(AssertionError):app.planning_request(revised=True)
            (app.root/'after-remove.json').write_text('{"restored":true,"usageUnchanged":true,"unknownFeesUnchanged":true}')
            old=copy.deepcopy(app.s['requests'])
            label,messages,previous=app.planning_request(revised=True)
            self.assertEqual(label,'revised-plan');self.assertEqual(messages[0],first)
            self.assertEqual(previous,returned['result']['draftIssue']);self.assertEqual(app.s['requests'],old)
            app.s['requests'][label]={'status':'returned','body':{'messages':messages},'result':returned['result']}
            with self.assertRaises(AssertionError):app.planning_request(revised=True)
            label,following,_=app.planning_request(correction=True,revised=True)
            self.assertEqual(label,'revised-correct');self.assertEqual(following[:len(messages)],messages)
            app.s['requests'][label]=returned
            with self.assertRaises(AssertionError):app.planning_request(correction=True,revised=True)

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
