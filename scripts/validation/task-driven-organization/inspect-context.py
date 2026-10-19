"""Read-only diagnostics for the stopped manager; no model or DB calls."""
import json, pathlib, urllib.request
root=pathlib.Path('/home/jj/.local/share/weiwu/validation/task-driven-organization-20261018/real-20261019')
s=json.loads((root/'state.json').read_text())
def get(path):
    with urllib.request.urlopen('http://127.0.0.1:4310/api/'+path) as r:return json.load(r)
run=get('runs/'+s['resumedRunId']+'/export')
(root/'stopped-manager-export.json').write_text(json.dumps(run,ensure_ascii=False))
wires=[e for e in run['events'] if e['type']=='model/wire-request']
def size(v):return len(json.dumps(v,ensure_ascii=False,separators=(',',':')).encode())
stats=[]
for e in wires:
    body=e['data']['body'];envelope={**body,'messages':[]}
    stats.append({'task':e.get('taskId',e['data'].get('taskId')),'wireBytes':size(body),'overhead':size(envelope)-2,
      'tools':[c['function']['name'] for m in body.get('messages',[]) for c in m.get('tool_calls',[])],
      'messageSizes':[size(m) for m in body.get('messages',[])]})
overhead=max(x['overhead'] for x in stats)
print(json.dumps({'stats':stats,'minimumBudgetOptions':[{'context':b,'calls':n,'budget':.063732+.006+n*((b+overhead+1024)*.3+8192*1.2)/1e6} for b in [96000,108000,118000] for n in [3,4]],
  'tail':[{'type':e['type'],'data':str(e['data'])[:2000]} for e in run['events'][-18:]],'pendingCosts':get('costs')['calls']},ensure_ascii=False))
