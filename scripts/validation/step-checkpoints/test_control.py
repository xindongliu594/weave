import pathlib, tempfile, unittest
try:
    from acceptance_control import patches
except ImportError:
    patches=None

class ControlTest(unittest.TestCase):
    def test_scoped_guards_preserve_original_source_and_fail_on_changed_anchor(self):
        self.assertTrue(callable(patches))
        with tempfile.TemporaryDirectory() as temp:
            root=pathlib.Path(temp);release=root/'release';phase=root/'phase'
            originals={'scripts/local-api.ts':b'// original server\n','apps/api/src/cost-control.ts':b'async function cost(){\n const prepared=prepareCompletionRequest(model,messages,maxTokens,request);\n}' }
            result=patches(originals,release,phase,{'conversationId':'conversation','model':{'id':'model','version':7,'inputRate':.3,'outputRate':1.2}})
            self.assertTrue(result['files']['scripts/local-api.ts'].endswith(originals['scripts/local-api.ts']))
            guard=result['files']['apps/api/src/cost-control.ts'].decode()
            self.assertIn('organization:conversation',guard)
            self.assertIn('assertRemainingCall',guard)
            self.assertIn("flag:'wx'",guard)
            self.assertIn('atStepBoundary',result['bootstrap'])
            self.assertNotIn('atAcceptedBoundary',result['bootstrap'])
            for changed in [b'no anchor',originals['apps/api/src/cost-control.ts']*2]:
                with self.assertRaises(AssertionError):patches({**originals,'apps/api/src/cost-control.ts':changed},release,phase,{'conversationId':'conversation','model':{}})

if __name__=='__main__':unittest.main()
