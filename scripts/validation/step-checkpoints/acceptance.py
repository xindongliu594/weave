"""Scoped real checkpoint acceptance through existing public APIs; no employee files are authored here."""
import copy, datetime, hashlib, json, os, pathlib, sys, urllib.error, urllib.request, uuid
from decimal import Decimal
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'acceptance-loop'))
from driver import validate_case

BASE='http://127.0.0.1:4310/api'
DEPT='62558bb0-cc2e-4356-ae7f-d53f919fec93'
MODEL='c8a4e6ad-1aaf-43a4-8ba1-d0a6cce59051'
SEED_PROJECT='6d1b5010-2da9-4d35-afb8-a0619540e12d'
PHASE=Decimal('.18'); PLANNING=Decimal('.03'); PROJECT=Decimal('.15'); CUMULATIVE=Decimal('3.41')

def validate_checkpoint_case(plan):
    developer=validate_case(plan)
    tasks={t['assigneeId']:t for t in plan['tasks']}
    qa,manager=tasks['qa-1'],tasks['mgr-1']
    assert qa.get('verificationReuse')=='same-workspace','QA must explicitly approve bounded readonly test reuse'
    assert all(set(a.get('tools',[]))<={'filesystem','artifact_write','terminal_test'} for a in plan['agents'])
    assert all(t.get('maxOutputTokens',8192)<=8192 and t.get('maxModelCalls',16)<=16 for t in plan['tasks'])
    assert sum(Decimal(str(t.get('maxBudget',0))) for t in plan['tasks'])<=PROJECT
    return {'developer':developer,'qa':qa['id'],'manager':manager['id']}

def totals(state,usage,holds):
    identity=lambda rows:{x['id']:(x['status'],Decimal(str(x['amount']))) for x in rows}
    assert identity(holds)==identity(state['baselineUnknown']),'New/changed unresolved billing: inspect, never replay'
    phase=sum((Decimal(str(x['cost'])) for x in usage if x['id'] not in state['baselineUsageIds']),Decimal(0))
    occupied=sum((Decimal(str(x['cost'])) for x in usage),Decimal(0))+sum((Decimal(str(x['amount'])) for x in holds),Decimal(0))
    phase=phase.quantize(Decimal('.000000001'));occupied=occupied.quantize(Decimal('.000000001'))
    assert phase<=PHASE and occupied<=CUMULATIVE,'Authorized amount exhausted'
    return {'phaseSpent':float(phase),'occupied':float(occupied),'phaseRemaining':float(PHASE-phase)}

class Acceptance:
    def __init__(self,root):
        self.root=pathlib.Path(root).resolve();self.path=self.root/'state.json'
        self.s=json.loads(self.path.read_text()) if self.path.exists() else {'requests':{}}

    def save(self):
        temp=self.path.with_suffix('.tmp')
        with temp.open('w',encoding='utf-8') as file:
            json.dump(self.s,file,ensure_ascii=False,indent=2);file.flush();os.fsync(file.fileno())
        temp.replace(self.path)

    def api(self,path,body=None,label=None):
        headers={'Content-Type':'application/json'}
        if body is not None:
            assert label and label not in self.s['requests'],'Already dispatched: inspect original result'
            headers['Idempotency-Key']=str(uuid.uuid4())
            self.s['requests'][label]={'path':path,'body':body,'key':headers['Idempotency-Key'],'status':'dispatching','at':datetime.datetime.now(datetime.timezone.utc).isoformat()};self.save()
        request=urllib.request.Request(BASE+path,data=None if body is None else json.dumps(body,ensure_ascii=False).encode(),headers=headers)
        try:
            with urllib.request.urlopen(request,timeout=230) as response:result=json.load(response)
        except urllib.error.HTTPError as error:
            result={'httpStatus':error.code,'message':error.read().decode()}
            if label:self.s['requests'][label].update(status='http_error',result=result);self.save()
            raise RuntimeError(json.dumps(result,ensure_ascii=False))
        if label:self.s['requests'][label].update(status='returned',result=result);self.save()
        return result

    def money(self):return totals(self.s,self.api('/usage'),self.api('/costs')['calls'])

    def prepare(self):
        assert not self.path.exists(),'Existing phase: inspect, never reset'
        assert self.root.name=='step-acceptance-20261020'
        self.root.mkdir(parents=True,exist_ok=True,mode=0o700)
        assert not [r for r in self.api('/runs') if r['status'] in ['running','queued']]
        usage,holds=self.api('/usage'),self.api('/costs')['calls']
        assert all(row['status']=='uncertain' for row in holds)
        department=next(d for d in self.api('/departments') if d['id']==DEPT)
        project=next(p for p in self.api('/projects') if p['id']==SEED_PROJECT)
        model=next(m for m in self.api('/models') if m['id']==MODEL)
        assert model['inputRate']==.3 and model['outputRate']==1.2 and model['status']=='available'
        policy=copy.deepcopy(project['policy'])
        policy.update(maxBudget=float(PROJECT),maxModelCalls=32,maxTaskModelCalls=16,maxConcurrentAgents=1,allowedKnowledgeSpaceIds=[],allowedTools=['filesystem','artifact_write','terminal_test'])
        self.s.update(baselineUsageIds=[u['id'] for u in usage],baselineUnknown=holds,departmentVersion=department['version'],conversationId=str(uuid.uuid4()),policy=policy,
                      model={'id':MODEL,'version':model['version'],'inputRate':model['inputRate'],'outputRate':model['outputRate']})
        assert Decimal(str(self.money()['occupied']))+PHASE<=CUMULATIVE
        self.s['prompt']='请生成可确认并执行的最小纯函数验收方案：复用现有部门的 dev-1、qa-1、mgr-1，不新增员工。普通 pipeline，省略 orchestration.template。开发生成 cli.mjs 与 README.md；cli.mjs 只导出纯函数 celsiusToFahrenheit(value)，公式 value*9/5+32，非 number 或非有限值抛 TypeError；不读写文件、时间、随机数、网络或环境变量。开发仅 node --check cli.mjs 语法自检，不生成或执行 QA 文件。QA 独立生成 cli.test.mjs，使用 node:test 与 node:assert/strict 直接 import 函数，实际执行 node --test cli.test.mjs；至少7项，覆盖0、100、-40、小数、负小数、字符串、null、NaN/Infinity等；不启动子进程、不写文件、不用外部状态。QA task 必须设置 verificationReuse="same-workspace"，允许完全相同版本的固定沙箱只读测试回执在中断后沿用；先拿到实际测试结果，再在下一轮做正式交接，禁止预报通过。经理仅只读三份文件与 QA 真实证据，不生成新产物、不开终端，做最终 review，reviewedTaskId 指开发。独立交付标准绑定 QA 验收条目，经理结论不再生成待自验产物。三节点 implementation→verification→review，QA依赖开发，经理依赖开发和QA，maxReworkRounds=0，inputs/outputs声明完整、producerTaskId正确。仅文件读写和隔离 terminal_test，无知识、外网或安装权限。各节点资源由你在项目$0.15、总32次/节点16次中合理分配，留足工具往返、认领、审批、恢复与结构化交接；每次输出最多8192Token，上下文96000字节。只返回精炼完整方案，交接字段简短。'
        self.save();return {'prepared':True,'conversationId':self.s['conversationId'],'money':self.money(),'modelCalls':0}

    def plan(self,correction=False):
        money=self.money();label='correct' if correction else 'plan'
        assert self.s.get('authorized') is True,'This phase allocation must be explicitly authorized first'
        if correction:assert 'plan' in self.s['requests'] and 'correct' not in self.s['requests']
        else:assert not any(k in self.s['requests'] for k in ['plan','correct'])
        remaining=PLANNING-Decimal(str(money['phaseSpent']));assert remaining>0
        messages=[{'role':'user','content':self.s['prompt']}]
        previous=None
        if correction:
            previous=self.s['plan'].get('draftIssue')
            reason=previous['message'] if previous else self.s.get('caseIssue')
            assert reason,'Do not repeat a valid plan without a concrete correction'
            messages.extend([{'role':'assistant','content':self.s['plan']['reply']},{'role':'user','content':'请按同一需求修正此问题并返回完整方案，不增加预算或权限：'+str(reason)}])
        control=json.loads((self.root/'control-installed.json').read_text())
        for relative,record in control['files'].items():assert hashlib.sha256((pathlib.Path(control['release'])/relative).read_bytes()).hexdigest()==record['patchedSha256']
        guard={'sessionId':'organization:'+self.s['conversationId'],'inputRate':.3,'outputRate':1.2,'allowance':float(remaining),'quotePath':str(self.root/(label+'-quote.json'))}
        assert not pathlib.Path(guard['quotePath']).exists()
        (self.root/'planning-guard.json').write_text(json.dumps(guard),encoding='utf-8')
        body={'organizationRouting':True,'conversationId':self.s['conversationId'],'modelId':MODEL,'templateId':'software','policy':self.s['policy'],'messages':messages}
        if previous:body['previousDraftIssue']=previous
        result=self.api('/organizations/chat',body,label)
        self.s['plan']=result
        if result.get('preview'):
            try:self.s['taskIds']=validate_checkpoint_case(result['preview']['plan']);self.s.pop('caseIssue',None)
            except AssertionError as error:self.s['caseIssue']=str(error) or '候选不符合纯函数、独立三阶段、权限或恢复证据约束'
        self.s['moneyAfterPlan']=self.money();self.save()
        return {'candidateValid':bool(result.get('preview') and not self.s.get('caseIssue')),'issue':self.s.get('caseIssue') or result.get('draftIssue'),'money':self.s['moneyAfterPlan']}

    def confirm(self):
        self.money();preview=self.s['plan']['preview'];assert preview['validation']['valid']
        self.s['taskIds']=validate_checkpoint_case(preview['plan'])
        assert preview['candidate']['target']=={'kind':'existing','departmentId':DEPT} or (preview['candidate']['target']['kind']=='existing' and preview['candidate']['target']['departmentId']==DEPT)
        assert preview['policy']['maxBudget']==float(PROJECT)
        assert next(d for d in self.api('/departments') if d['id']==DEPT)['version']==self.s['departmentVersion']
        self.save();result=self.api('/organizations/previews/'+preview['previewId']+'/confirm',{'previewVersion':preview.get('previewVersion',1)},'confirm')
        self.s['projectId']=result['projectId'];self.save();return {'projectId':self.s['projectId']}

    def start(self):
        self.money();project=next(p for p in self.api('/projects') if p['id']==self.s['projectId'])
        assert project['validation']['valid'] and project['policy']==self.s['policy']
        assert project['plan']==self.s['plan']['preview']['plan'];validate_checkpoint_case(project['plan'])
        assert (self.root/'control-installed.json').exists()
        result=self.api('/projects/'+project['id']+'/approve',{'version':project['version']},'start')
        self.s['runId']=result['id'];self.save();return {'runId':result['id']}

if __name__=='__main__':
    os.umask(0o077)
    assert len(sys.argv)==3,'Usage: acceptance.py ROOT prepare|plan|correct|confirm|start|status'
    app=Acceptance(sys.argv[1]);mode=sys.argv[2]
    if mode=='prepare':result=app.prepare()
    elif mode in ['plan','correct']:result=app.plan(mode=='correct')
    elif mode=='confirm':result=app.confirm()
    elif mode=='start':result=app.start()
    elif mode=='status':
        rid=app.s.get('resumedRunId',app.s.get('runId'));run=app.api('/runs/'+rid+'?limit=1') if rid else {}
        result={'id':rid,'status':run.get('status'),'error':run.get('error'),'boundary':(app.root/'boundary.json').exists(),'money':None if run.get('status') in ['queued','running'] else app.money()}
    else:raise RuntimeError('Unknown mode')
    print(json.dumps(result,ensure_ascii=False))
