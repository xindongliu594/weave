"""One bounded real acceptance through public product APIs. Never replay labels."""
import copy, datetime, hashlib, json, os, pathlib, sys, urllib.error, urllib.request, uuid
from decimal import Decimal

ROOT = pathlib.Path('/home/jj/.local/share/weiwu/validation/acceptance-loop-20261019-958b45e')
STATE = ROOT / 'state.json'
BASE = 'http://127.0.0.1:4310/api'
DEPT = '62558bb0-cc2e-4356-ae7f-d53f919fec93'
MODEL = 'c8a4e6ad-1aaf-43a4-8ba1-d0a6cce59051'
os.umask(0o077)
s = json.loads(STATE.read_text()) if STATE.exists() else {'requests': {}}
def save():
    temp=STATE.with_suffix('.tmp'); temp.write_text(json.dumps(s,ensure_ascii=False,indent=2)); temp.replace(STATE)
def api(path,body=None,label=None):
    headers={'Content-Type':'application/json'}
    if body is not None:
        assert label and label not in s['requests'], 'Already dispatched; inspect rather than replay'
        headers['Idempotency-Key']=str(uuid.uuid4())
        s['requests'][label]={'path':path,'body':body,'key':headers['Idempotency-Key'],'status':'dispatching','at':datetime.datetime.now(datetime.timezone.utc).isoformat()};save()
    req=urllib.request.Request(BASE+path,data=None if body is None else json.dumps(body,ensure_ascii=False).encode(),headers=headers)
    try:
        with urllib.request.urlopen(req,timeout=230) as r:result=json.load(r)
    except urllib.error.HTTPError as e:
        result={'httpStatus':e.code,'response':e.read().decode()}
        if label:s['requests'][label].update(status='rejected',result=result);save()
        raise RuntimeError(json.dumps(result,ensure_ascii=False))
    if label:s['requests'][label].update(status='returned',result=result);save()
    return result
def money():
    usage,costs=api('/usage'),api('/costs')
    assert {c['id']:c['amount'] for c in costs['calls']}=={c['id']:c['amount'] for c in s['baselineUnknown']}, 'Pending/new unknown call: do not replay'
    added=[u for u in usage if u['id'] not in s['baselineUsageIds']]
    phase=sum(Decimal(str(u['cost'])) for u in added)
    total=sum(Decimal(str(u['cost'])) for u in usage)+sum(Decimal(str(c['amount'])) for c in costs['calls'])
    assert phase<=Decimal('.28') and total<=Decimal('3.41')
    return {'phaseSpent':float(phase),'cumulativeOccupied':float(total),'newUsage':added}
def ready_guard(name):
    guard=json.loads((ROOT/name).read_text())
    source=pathlib.Path('/home/jj/.local/share/weiwu/releases/weiwu-task-organization-20261018/apps/api/src/cost-control.ts')
    assert hashlib.sha256(source.read_bytes()).hexdigest()==guard['patchedSha256'], 'Planning guard is not installed'
    return guard
def validate_case(plan):
    assert plan['orchestration']['pattern']=='pipeline' and not plan['orchestration'].get('template')
    assert {a['id'] for a in plan['agents']}=={'dev-1','qa-1','mgr-1'} and len(plan['tasks'])==3
    by_owner={t['assigneeId']:t for t in plan['tasks']}
    assert set(by_owner)=={'dev-1','qa-1','mgr-1'}
    d,q,m=(by_owner[k] for k in ['dev-1','qa-1','mgr-1'])
    assert [t['kind'] for t in [d,q,m]]==['implementation','verification','review']
    assert all(t.get('maxReworkRounds',0)==0 for t in [d,q,m])
    assert d['dependencies']==[] and q['dependencies']==[d['id']] and set(m['dependencies'])=={d['id'],q['id']}
    outputs=lambda t:{o['path'] for o in t['outputs']}
    inputs=lambda t:{(i['path'],i['producerTaskId']) for i in t['inputs']}
    assert outputs(d)=={'cli.mjs','README.md'} and outputs(q)=={'cli.test.mjs'} and not m['outputs']
    assert not d['inputs'] and inputs(q)=={('cli.mjs',d['id']),('README.md',d['id'])}
    assert inputs(m)==inputs(q)|{('cli.test.mjs',q['id'])} and m['reviewedTaskId']==d['id']
    assert d['verify']==['node --check cli.mjs'] and not d.get('acceptanceChecks')
    assert q['verify']==['node --test cli.test.mjs'] and not m.get('verify')
    assert q['acceptanceChecks'] and all(c['command']=='node --test cli.test.mjs' and c.get('minimumTests',0)>=7 and c.get('expectedExitCode')==0 for c in q['acceptanceChecks'])
    assert plan['deliveryCriteria'] and all(c['producerTaskIds']==[d['id']] and c['checkTaskId']==q['id'] and c['independent'] for c in plan['deliveryCriteria'])
    return d['id']
def snapshot(name):
    data={'usage':api('/usage'),'costs':api('/costs'),'projects':api('/projects'),'departments':api('/departments')}
    for key in ['runId','resumedRunId']:
        if key in s:
            rid=s[key];data[key]={'export':api('/runs/'+rid+'/export'),'artifacts':api('/runs/'+rid+'/artifacts'),'operations':api('/runs/'+rid+'/local-operations'),'recovery':api('/runs/'+rid+'/recovery-check')}
    with (ROOT/name).open('x') as f:json.dump(data,f,ensure_ascii=False,indent=2)
    return {'saved':name}
if __name__=='__main__':
    mode=sys.argv[1]
    if mode=='prepare':
        assert not STATE.exists()
        pre=json.loads((ROOT/'preflight.json').read_text())
        assert len(pre['usage'])==681 and len(pre['costs']['calls'])==7
        assert not [r for r in api('/runs') if r['status'] in ['running','queued']]
        s.update(baselineUsageIds=[u['id'] for u in pre['usage']],baselineUnknown=pre['costs']['calls'],baselineDepartment=next(d for d in pre['departments'] if d['id']==DEPT),conversationId=str(uuid.uuid4()))
        policy=copy.deepcopy(next(p for p in pre['projects'] if p['id']=='cb8bf583-4356-4b35-bbc7-3e92e9f186bf')['policy'])
        policy.update(maxBudget=.25,maxModelCalls=32,maxTaskModelCalls=16,allowedKnowledgeSpaceIds=[],allowedTools=['filesystem','artifact_write','terminal_test'])
        s['policy']=policy
        s['prompt']='请生成可确认并实际执行的最小温度换算项目方案：复用目录中现有部门的开发、QA、经理三人，不新增部门。采用现有普通 pipeline 顺序布局，省略 orchestration.template（七种新模板目前仅预览）。开发生成 cli.mjs 和 README.md：Node 无第三方依赖命令行，接受唯一数字位置参数，允许负数、小数，stdout 输出 JSON {celsius,fahrenheit}，F=C*9/5+32；缺失、非数字或多个参数时 stderr 提示并非零退出。开发只执行 node --check cli.mjs 语法自检，不生成或调用 QA 文件，不把语法自检绑定功能验收。独立 QA 读取开发两份文件后自行生成 cli.test.mjs，用 Node 内置 node:test 和 assert 编写并实际执行 node --test cli.test.mjs；至少核对0、100、-40、小数、缺失、非数字、多参数，检查 stdout JSON 数值及错误退出/stderr。经理最后读取所有文件和 QA 真实测试证据，作简短结构化交接结论，不写新文件、不自编测试结果。业务交付标准绑定独立 QA 的对应验收条目；经理结论不再作为需后续自验的新产物。文件引用按 producerTaskId 正确连接，QA 验收命令只使用本节点产出的测试文件及已完成开发输入。三任务顺序执行，maxReworkRounds为0；经理要的交接字段简短、列事实与证据，避免长篇重复。真实模型资源由你在项目0.25美元内安排，总32次/单节点16次，上下文96000字节、输出最多8192Token；留出认领、读写、工具审批、测试回读、正式交接与恢复所需轮数。每个节点输出上限8192，不把整个任务估算误当单次输出。仅授权文件与隔离终端，不访问知识库、网络或安装依赖。直接返回完整精炼候选。'
        save();result={'prepared':True,'conversationId':s['conversationId'],'money':money()}
    elif mode=='plan':
        money();guard=ready_guard('planning-guard-installed.json')
        assert guard['sessionId']=='organization:'+s['conversationId'] and guard['allowance']==.03
        result=api('/organizations/chat',{'organizationRouting':True,'conversationId':s['conversationId'],'modelId':MODEL,'templateId':'software','policy':s['policy'],'messages':[{'role':'user','content':s['prompt']}]},label='plan')
        s['plan']=result;s['moneyAfterPlan']=money();save()
    elif mode=='correct':
        check=money();prior=s['plan'];assert prior.get('draftIssue') and not prior.get('preview')
        allowance=Decimal('.03')-Decimal(str(check['phaseSpent']))
        guard=ready_guard('correction-guard-installed.json')
        # Public JSON costs contain binary floating tails; compare at nanodollar precision.
        assert guard['sessionId']=='organization:'+s['conversationId'] and round(guard['allowance'],9)<=round(float(allowance),9)
        correction='上一轮没有通过结构校验：'+prior['draftIssue']['message']+' 请保留同一需求、三人三节点与预算。经理最终节点明确使用 kind=review，reviewedTaskId 指开发任务 ID，读取开发两份文件和 QA 测试文件，依赖开发与 QA，maxReworkRounds=0；QA 用 kind=verification。经理的 acceptanceCriteria 和 handoff 仅要求只读审查、QA 实测证据与最终判定，不创建文件、不做自验循环。返回完整修正版候选。'
        s['firstPlan']=prior;save()
        result=api('/organizations/chat',{'organizationRouting':True,'conversationId':s['conversationId'],'modelId':MODEL,'templateId':'software','policy':s['policy'],'messages':[{'role':'user','content':s['prompt']},{'role':'assistant','content':prior['reply']},{'role':'user','content':correction}],'previousDraftIssue':prior['draftIssue']},label='correct')
        s['plan']=result;s['moneyAfterPlan']=money();save()
    elif mode=='confirm':
        money();draft=s['plan']['preview']
        assert draft['validation']['valid'] and draft['candidate']['target']['kind']=='existing'
        assert draft['candidate']['target']['departmentId']==DEPT and draft['policy']['maxBudget']==.25
        assert not draft['plan']['orchestration'].get('template')
        assert len(draft['plan']['tasks'])==3
        assert all(t.get('maxOutputTokens',0)<=8192 and t.get('maxModelCalls',0)<=16 for t in draft['plan']['tasks'])
        assert next(d for d in api('/departments') if d['id']==DEPT)['version']==s['baselineDepartment']['version']
        s['developerTaskId']=validate_case(draft['plan']);save()
        result=api('/organizations/previews/'+draft['previewId']+'/confirm',{'previewVersion':1},label='confirm')
        s['projectId']=result['projectId'];save()
    elif mode=='approve':
        money();p=next(p for p in api('/projects') if p['id']==s['projectId'])
        assert p['policy']==s['policy'] and p['validation']['valid']
        assert p['plan']==s['plan']['preview']['plan']
        validate_case(p['plan'])
        assert json.loads((ROOT/'control-installed.json').read_text())['projectId']==s['projectId']
        result=api('/projects/'+s['projectId']+'/approve',{'version':p['version']},label='approve')
        s['runId']=result['id'];save()
    elif mode=='resume':
        money();check=api('/runs/'+s['runId']+'/recovery-check')
        assert check['resume']['allowed'] and check['resume']['completedTaskIds']==[s['developerTaskId']] and check['unknownOperationCount']==0,json.dumps(check,ensure_ascii=False)
        s['recoveryCheck']=check;save()
        result=api('/runs/'+s['runId']+'/retry',{'resume':True},label='resume')
        s['resumedRunId']=result['id'];save()
    elif mode=='status':
        rid=s.get('resumedRunId',s.get('runId'))
        run=api('/runs/'+rid+'?limit=1') if rid else {}
        approvals=api('/approvals?runId='+rid) if rid else []
        result={'id':rid,'status':run.get('status'),'error':run.get('error'),'eventCount':run.get('eventCount'),'pending':[a for a in approvals if a['status']=='pending'],'boundary':(ROOT/'boundary.json').exists(),'money':money() if run.get('status')!='running' else None}
    elif mode=='snapshot':result=snapshot(sys.argv[2])
    else:raise RuntimeError('Unknown mode')
    print(json.dumps(result,ensure_ascii=False))
