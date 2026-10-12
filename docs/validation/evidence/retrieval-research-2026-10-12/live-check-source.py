from pathlib import Path
import urllib.request, json, time, datetime, math, sys
remote='--remote' in sys.argv
base='http://127.0.0.1:4310/api' if remote else 'http://127.0.0.1:4312/api'
def api(path,body=None):
    req=urllib.request.Request(base+path,data=None if body is None else json.dumps(body,ensure_ascii=False).encode(),headers={'Content-Type':'application/json'},method='GET' if body is None else 'POST')
    with urllib.request.urlopen(req,timeout=15) as response:return json.load(response)
out=Path('docs/validation/evidence/retrieval-research-2026-10-12')
retrieval=api('/knowledge/retrieval')
assert retrieval['mode']=='keyword','Stop: live mode is not the cost-free keyword path to measure'
dept=next(d for d in api('/departments') if d['id']=='62558bb0-cc2e-4356-ae7f-d53f919fec93')
agent=next(a for a in dept['agents'] if a['id']=='qa-1')
assert all(t in agent['tools'] for t in ('knowledge_search','knowledge_read'))
assert '5928897e-5aec-4aa0-a683-e7b77bf684de' in agent.get('knowledgeSpaceIds',[])
usageBefore=api('/usage');holdsBefore=api('/costs')['calls']
results=[]
for query in ['整数','退款','库存','检索不存在的测试词zetaomega']:
    times=[];sources=[]
    for i in range(12):
        start=time.perf_counter();found=api('/knowledge/search',{'departmentId':dept['id'],'agentId':agent['id'],'query':query});times.append((time.perf_counter()-start)*1000)
        assert isinstance(found,list)
        sources=[{k:v for k,v in f.items() if k in ('documentId','version','sha256')} for f in found]
    ordered=sorted(times[2:])
    results.append({'query':query,'warmupQueries':2,'measuredSamples':len(ordered),'firstHttpMs':times[0],'medianHttpMs':ordered[len(ordered)//2],'p95HttpMs':ordered[math.ceil(len(ordered)*.95)-1],'returnedChunks':len(found),'sources':sources})
usageAfter=api('/usage');holdsAfter=api('/costs')['calls']
result={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'endpoint':base+'/knowledge/search','departmentId':dept['id'],'agentId':agent['id'],'mode':'keyword','concurrency':1,'network':'JJ urllib loopback HTTP, invoked over SSH; excludes SSH RTT' if remote else 'Windows urllib HTTP over existing SSH tunnel to JJ service','queries':results,'usageRecordsBefore':len(usageBefore),'usageRecordsAfter':len(usageAfter),'knownCostBefore':sum(float(x['cost']) for x in usageBefore),'knownCostAfter':sum(float(x['cost']) for x in usageAfter),'unknownHoldsBefore':sum(float(x['amount']) for x in holdsBefore),'unknownHoldsAfter':sum(float(x['amount']) for x in holdsAfter),'measurementModelCalls':0,'limitations':['Small existing authorized test corpus; not a large-corpus throughput test.','Includes loopback HTTP and current-version interactive authorization; fixed-manifest worker SQL is measured separately.','10 measured samples per query; P95 is effectively the slowest sample.']}
if not remote:
    out.mkdir(exist_ok=True,parents=True);(out/'jj-live-results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(result,ensure_ascii=True))
