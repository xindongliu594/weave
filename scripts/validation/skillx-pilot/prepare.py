"""Read-only projection of an accepted manager task, retaining exact source references."""
import hashlib,json,pathlib,urllib.request

RUN='e5b2acfd-ecc4-4127-bd2f-4e65aad60baa'
ROOT=pathlib.Path('/home/jj/.local/share/weiwu/validation/skillx-pilot-20261015')
def get(path):
 with urllib.request.urlopen('http://127.0.0.1:4310/api'+path,timeout=40) as response:return json.load(response)

def prepare():
 run=get('/runs/'+RUN+'/export');record=get('/knowledge/work-records/'+RUN)
 assert run['status']=='completed' and run['integrity']=='ok' and record['shareable']
 task=next(t for t in run['snapshot']['tasks'] if t['id']=='t3-review')
 finished=next(e for e in run['events'] if e['type']=='run/finished')
 qa=next(t for t in finished['data']['tasks'] if t['seed_id']=='t2-qa')['output']
 report=next(t for t in finished['data']['tasks'] if t['seed_id']=='t3-review')['output']
 history=[{'role':'user','content':task['objective']+'\n已封存QA原始回执：\n'+qa,'source':{'eventSeq':finished['seq'],'field':'tasks[t2-qa].output'}}]
 names={'filesystem','knowledge_read'};ids={};selected=[]
 for event in run['events']:
  if event['type']=='session/tool/call' and event['data']['name'] in names:
   call=event['data'];ids[call['callId']]=call['name']
   history.append({'role':'assistant','content':'','tool_calls':[{'name':call['name'],'arguments':json.loads(call['arguments'])}],'source':{'eventSeq':event['seq']}});selected.append(event['seq'])
  if event['type']=='session/tool/result':
   message=event['data']['message'];call_id=message.get('source',{}).get('callId')
   if call_id not in ids:continue
   blocks=[b for entry in message['content'] for b in entry.get('content',[]) if b.get('type')=='text']
   history.append({'role':'tool','name':ids[call_id],'content':'\n'.join(b['text'] for b in blocks),'source':{'eventSeq':event['seq']}});selected.append(event['seq'])
 history.append({'role':'assistant','content':report,'source':{'eventSeq':finished['seq'],'field':'tasks[t3-review].output'}})
 assert len(ids)==2 and len(history)==6 and all(step['content'] or step.get('tool_calls') for step in history)
 wire=next(e for e in run['events'] if e['type']=='model/wire-request')
 schemas={entry['function']['name']:entry['function'] for entry in wire['data']['body']['tools'] if entry.get('type')=='function' and entry['function']['name'] in names}
 assert set(schemas)==names
 payload={'trajectory_id':RUN+':t3-review','task_id':'t3-review','user_task':task['objective'],'task_history':history,'reward':1.0,'metadata':{'sourceRunId':RUN,'projection':'selected read-only source evidence; not a full transcript','eventSeqs':selected}}
 # Reuse the original employee-authored approved task as one existing plan, not a new generated deliverable.
 sample={'trajectory':payload,'existingPlan':'# step 1: '+task['objective'],'toolSchemas':schemas,'sourceRunId':RUN,'snapshotKnowledgeSHA':hashlib.sha256(json.dumps(run['snapshot']['knowledge'],sort_keys=True,ensure_ascii=False).encode()).hexdigest()}
 (ROOT/'sample.json').write_text(json.dumps(sample,ensure_ascii=False,indent=2),encoding='utf8')
 return {'sourceRunId':RUN,'historyEntries':len(history),'sourceEventSeqs':selected,'sampleBytes':len(json.dumps(sample,ensure_ascii=False).encode()),'originalPlanReused':True,'modelCalls':0}

if __name__=='__main__':print(json.dumps(prepare()))
