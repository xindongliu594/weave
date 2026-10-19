import ast,pathlib,tempfile,unittest

class RollbackTest(unittest.TestCase):
 def test_active_new_service_is_stopped_before_original_unit_is_restored(self):
  source=ast.parse(pathlib.Path(__file__).with_name('deploy.py').read_text())
  definition=next((n for n in source.body if isinstance(n,ast.FunctionDef) and n.name=='rollback_service'),None)
  self.assertIsNotNone(definition,'Rollback must be independently verifiable')
  calls=[]
  with tempfile.TemporaryDirectory() as directory:
   unit=pathlib.Path(directory)/'unit';unit.write_text('new')
   class Processes:
    @staticmethod
    def run(args,check):calls.append((args[-2:] if args[-1]=='daemon-reload' else args[-2],unit.read_text()))
   namespace={'subprocess':Processes,'SERVICE':'fixture','UNIT':unit,'os':__import__('os'),'command':lambda *a:'old','OLD':'old','wait_health':lambda:calls.append(('healthy',unit.read_text()))}
   exec(compile(ast.Module(body=[definition],type_ignores=[]),'deploy-rollback','exec'),namespace)
   namespace['rollback_service']('original')
   self.assertEqual(calls[0],('stop','new'))
   self.assertEqual(calls[-2:], [('start','original'),('healthy','original')])
if __name__=='__main__':unittest.main()
