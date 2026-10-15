"""Audit saved real evidence without executing candidate code or calling a model."""
import ast,json,pathlib,sys

def audit(root):
 def read(name):return json.loads((root/name).read_text(encoding='utf8'))
 before=read('before.json');after=read('after.json');result=read('result-live.json');sample=read('sample.json')
 calls=[read('call-'+str(i)+'.json') for i in range(1,result['modelRequestsRequested']+1)]
 usage={row['id']:row for row in after['trialUsage']}
 assert len(calls)==len(usage) and all(call['usageId'] in usage for call in calls)
 assert all(call['status']=='returned' and call['finishReason']=='stop' for call in calls)
 preserved={'source':before['sourceRunId']==after['sourceRunId']==sample['sourceRunId'],
  'snapshot':before['snapshotSHA']==after['snapshotSHA'],'events':before['eventsSHA']==after['eventsSHA'],
  'files':before['files']==after['files'],'oldHolds':all(h in after['holds'] for h in before['holds'])}
 assert all(preserved.values()) and after['pendingCount']==0
 assert before['status']==after['status']=='completed' and before['integrity']==after['integrity']=='ok'
 assert before['shareable'] and after['shareable'] and after['usageCount']-before['usageCount']==len(calls)
 # This auditor certifies this observed rejection, not arbitrary future trials.
 assert next(c['text'].strip() for c in calls if c['stage']=='general-filter')=='bad'
 assert result['final_skills_count']==0 and all(not epoch['filtered_skills'] for epoch in result['epochs'])
 assert all(not collection for collection in result['skills']['skills'].values())
 receipts=[{'stage':c['stage'],'usageId':c['usageId'],'inputTokens':usage[c['usageId']]['inputTokens'],'outputTokens':usage[c['usageId']]['outputTokens'],'cost':usage[c['usageId']]['cost']} for c in calls]
 extracted=result['epochs'][0]['extracted_skills']
 missing=[];syntax=[]
 responses={step['name']:json.loads(step['content']) for step in sample['trajectory']['task_history'] if step['role']=='tool'}
 for item in extracted:
  tree=ast.parse(item['skill']['content']);syntax.append(True)
  bindings={node.targets[0].id:node.value.func.id for node in ast.walk(tree) if isinstance(node,ast.Assign) and len(node.targets)==1 and isinstance(node.targets[0],ast.Name) and isinstance(node.value,ast.Call) and isinstance(node.value.func,ast.Name) and node.value.func.id in responses}
  for node in ast.walk(tree):
   if isinstance(node,ast.Subscript) and isinstance(node.value,ast.Name) and node.value.id in bindings and isinstance(node.slice,ast.Constant):
    tool=bindings[node.value.id];key=node.slice.value
    if key not in responses[tool]:missing.append({'tool':tool,'field':key,'line':node.lineno})
 total=sum(row['cost'] for row in receipts)
 assert abs(after['occupied']-before['occupied']-total)<1e-9 and total<=.03
 return {'sourceRunId':sample['sourceRunId'],'sourceEventSeqs':sample['trajectory']['metadata']['eventSeqs'],
  'upstreamCommit':read('setup-result.json')['commit'],'extractedCandidates':len(extracted),'acceptedCandidates':result['final_skills_count'],
  'generalFilterResponse':next(c['text'] for c in calls if c['stage']=='general-filter'),
  'toolFilterExecuted':any(c['stage']=='tool-filter' for c in calls),'receipts':receipts,'cost':total,
  'inputTokens':sum(r['inputTokens'] for r in receipts),'outputTokens':sum(r['outputTokens'] for r in receipts),
  'occupiedBefore':before['occupied'],'occupiedAfter':after['occupied'],'oldHoldCount':len(before['holds']),
  'preserved':preserved,'candidatePythonSyntaxValid':all(syntax),'missingResponseFields':missing,
  'candidateExecuted':False,'candidatePublished':False,'localLLMInstalled':False,'qualityConclusion':'rejected; not ready for reuse'}

if __name__=='__main__':
 print(json.dumps(audit(pathlib.Path(sys.argv[1])),ensure_ascii=False,indent=2))
