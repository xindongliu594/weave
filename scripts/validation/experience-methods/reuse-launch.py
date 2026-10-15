"""Run the bounded resource planner with service-owned DB settings, never a raw API key."""
import os,pathlib,subprocess,sys
root=pathlib.Path('/home/jj/.local/share/weiwu/validation/experience-methods-20261015')
mode=sys.argv[1]
assert mode in ['inspect','plan','save','start','status','recovery-inspect']
environment=dict(os.environ)
if mode in ['plan','recovery-inspect']:
    pid=subprocess.check_output(['systemctl','--user','show','weiwu-jj.service','-p','MainPID','--value'],text=True).strip()
    children=pathlib.Path('/proc/'+pid+'/task/'+pid+'/children').read_text().split()
    api_pid=next(c for c in children if b'scripts/local-api.ts' in pathlib.Path('/proc/'+c+'/cmdline').read_bytes())
    private=dict(e.split(b'=',1) for e in pathlib.Path('/proc/'+api_pid+'/environ').read_bytes().split(b'\0') if b'=' in e)
    for key in ['DATABASE_URL','DATA_DIR','TRACE_ROOT','AGENT_DEPARTMENT_LOCAL','LOCAL_WORKSPACE_ROOT']:environment[key]=private[key.encode()].decode()
entry='recovery-inspect.mjs' if mode=='recovery-inspect' else 'reuse.mjs'
sys.exit(subprocess.call(['/home/jj/.local/share/weiwu/runtime/node-v24.19.0-linux-x64/bin/node','--import','tsx',str(root/'control'/entry),mode],cwd='/home/jj/.local/share/weiwu/releases/weiwu-recovery-context-20261015',env=environment))
