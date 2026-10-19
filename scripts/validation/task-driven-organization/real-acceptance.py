"""Bounded real acceptance via normal public APIs; labels cannot be replayed."""
import copy, datetime, json, os, pathlib, sys, urllib.error, urllib.request, uuid
from decimal import Decimal

ROOT = pathlib.Path('/home/jj/.local/share/weiwu/validation/task-driven-organization-20261018/real-20261019')
STATE = ROOT / 'state.json'
BASE = 'http://127.0.0.1:4310/api'
DEPT = '830c5454-a0d8-477c-912c-2273dfd2b7de'
MODEL = 'c8a4e6ad-1aaf-43a4-8ba1-d0a6cce59051'
os.umask(0o077)
s = json.loads(STATE.read_text()) if STATE.exists() else {'authorization': {'phase': .34, 'planning': .06, 'project': .28, 'cumulative': 3.41, 'planningCalls': 3}, 'requests': {}}
def save():
    temp = STATE.with_suffix('.tmp'); temp.write_text(json.dumps(s, ensure_ascii=False, indent=2)); temp.replace(STATE)
def api(path, body=None, method=None, label=None):
    method = method or ('POST' if body is not None else 'GET')
    headers = {'Content-Type': 'application/json'}
    if method != 'GET':
        assert label and label not in s['requests'], 'Already dispatched; inspect receipt, never replay: ' + str(label)
        key = str(uuid.uuid4()); headers['Idempotency-Key'] = key
        s['requests'][label] = {'path': path, 'body': body, 'key': key, 'status': 'dispatching', 'at': datetime.datetime.now(datetime.timezone.utc).isoformat()}; save()
    req = urllib.request.Request(BASE + path, data=None if body is None else json.dumps(body, ensure_ascii=False).encode(), headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=230) as r: result = json.load(r)
    except urllib.error.HTTPError as e:
        result = {'httpStatus': e.code, 'response': e.read().decode()}
        if label: s['requests'][label].update(status='rejected', result=result); save()
        raise RuntimeError(json.dumps(result, ensure_ascii=False))
    except Exception:
        # Dispatch record deliberately stays unresolved: no automatic retry.
        raise
    if label: s['requests'][label].update(status='returned', result=result); save()
    return result
def money_check():
    usage, costs = api('/usage'), api('/costs')
    new = [u for u in usage if u['id'] not in s['baselineUsageIds']]
    old_unknown = {c['id']: c['amount'] for c in s['baselineUnknown']}
    unknown = {c['id']: c['amount'] for c in costs['calls']}
    assert unknown == old_unknown, 'Pending or new unknown call: reconcile, do not replay'
    spent = sum(Decimal(str(u['cost'])) for u in new)
    cumulative = sum(Decimal(str(u['cost'])) for u in usage) + sum(Decimal(str(v)) for v in unknown.values())
    assert spent <= Decimal('.34') and cumulative <= Decimal('3.41')
    return {'phaseSpent': float(spent), 'cumulativeOccupied': float(cumulative), 'newUsage': new}

if __name__ == '__main__':
    mode = sys.argv[1]
    if mode == 'prepare':
        assert not STATE.exists()
        pre = json.loads((ROOT / 'preflight.json').read_text())
        assert len(pre['usage']) == 639 and len(pre['costs']['calls']) == 6
        assert not [r for r in api('/runs') if r['status'] in ['running', 'queued']]
        s['baselineUsageIds'] = [u['id'] for u in pre['usage']]; s['baselineUnknown'] = pre['costs']['calls']
        s['baselineDepartment'] = next(d for d in pre['departments'] if d['id'] == DEPT)
        old = next(p for p in pre['projects'] if p['id'] == '5b0f9606-859f-4c63-96b3-4e7e0d7412ec')
        policy = copy.deepcopy(old['policy']); policy.update(maxBudget=.28, maxModelCalls=48, maxTaskModelCalls=24)
        s['policy'] = policy
        s['prompts'] = {
          'word': '请形成可确认的团队方案：沿用目录里的原生办公插件验收部门，不新增员工。仅用虚构资料制作一页 report.docx：首页通过、登录通过、备份失败；统计总计3项、2通过、1失败，并明确标注虚构测试资料、未访问网站或真实巡检。作者使用已授权原版 docx_create 创建并 docx_read 回读；独立QA读取当前文件、逐项核对这四点，输出 qa.json；经理读取DOCX和QA后输出 acceptance.json，发现不符必须报告fail。只产出这三个文件。请按任务推荐协作方式，解释人员与依赖，并将用户交付标准绑定独立检查。经理与QA的短JSON至少含verdict和证据。交接章节简短但要有实际事实、结论、依据、限制。不使用终端，无额外权限。每节点请分配足够的认领、检索、加载工具、读写与正式交接轮数，完整项目含恢复限0.28美元，总48次、单节点24次、输出8192Token。三个节点有序执行，任务kind=work。请精炼输出完整JSON，不罗列操作教程。',
          'summary': '请给出可确认的团队方案但不要执行：将虚构数据A（工单总数10，解决8）和B（总数20，解决17）汇总成短的summary.json，总计30，解决25，未解决5，并注明虚构资料。独立人员核对计算与来源，经理确认。仅用已有获授权文件能力；推荐最合适的人员、协作方式及理由，将交付标准绑定核对。省略不必要步骤。',
          'temperature': '请给出可确认的团队方案但不要执行：需求是开发一个摄氏转华氏的小脚本，要求0C=32F、100C=212F和非法输入提示。当前权限只有办公文件工具，没有终端或运行测试权限。请识别能力缺口，提出当前可做的需求/测试说明，不能承诺已写代码或执行测试；根据授权目录推荐组织与协作方式、后续交付和独立核对方法。无合适部门时解释理由并提出待确认的部门方案，不能扩大工具权限。精炼。'
        }
        s['conversations'] = {k: str(uuid.uuid4()) for k in s['prompts']}; save()
        print(json.dumps({'prepared': True, 'money': money_check(), 'policy': policy}, ensure_ascii=False))
    elif mode == 'plan':
        scenario = sys.argv[2]; assert scenario in s['prompts']
        assert scenario=='temperature', 'Completed scenario entrypoints are frozen; no further paid corrections'
        check = money_check()
        planning = [u for u in check['newUsage'] if u.get('sessionId') in ['organization:' + v for v in s['conversations'].values()]]
        assert sum(Decimal(str(u['cost'])) for u in planning)+Decimal('.02') <= Decimal('.06')
        guard=json.loads((ROOT/'planning-guard-installed.json').read_text())
        assert guard['sessionId']=='organization:'+s['conversations'][scenario] and guard['allowance']==.02
        assert len([k for k in s['requests'] if k.startswith('plan-')]) < 3
        result = api('/organizations/chat', {'organizationRouting': True, 'conversationId': s['conversations'][scenario], 'modelId': MODEL, 'templateId': 'software', 'policy': s['policy'], 'messages': [{'role': 'user', 'content': s['prompts'][scenario]}]}, label='plan-' + scenario)
        s.setdefault('plans', {})[scenario] = result; s['lastMoney'] = money_check(); save()
        print(json.dumps({'scenario': scenario, 'result': result, 'money': s['lastMoney']}, ensure_ascii=False))
    elif mode == 'confirm':
        money_check(); draft=s['plans']['wordCorrection']['preview']
        assert draft['validation']['valid'] and draft['candidate']['target']['kind']=='existing'
        assert draft['candidate']['target']['departmentId']==DEPT and draft['policy']['maxBudget']==.26
        assert set(a['id'] for a in draft['plan']['agents'])=={'writer','qa','manager'}
        assert all(t.get('maxOutputTokens',0)<=8192 and t.get('maxModelCalls',0)<=24 for t in draft['plan']['tasks'])
        assert next(d for d in api('/departments') if d['id']==DEPT)['version']==s['baselineDepartment']['version']
        result=api('/organizations/previews/'+draft['previewId']+'/confirm',{'previewVersion':1},label='confirm-word')
        s['projectId']=result['projectId']; save(); print(json.dumps(result))
    elif mode == 'approve':
        money_check(); p=next(p for p in api('/projects') if p['id']==s['projectId'])
        assert p['policy']['maxBudget']==.26 and p['policy']['maxModelCalls']==48 and p['validation']['valid']
        result=api('/projects/'+s['projectId']+'/approve',{'version':p['version']},label='approve-word')
        s['runId']=result['id']; save(); print(json.dumps(result))
    elif mode == 'resume':
        money_check(); check=api('/runs/'+s['runId']+'/recovery-check')
        assert check['resume']['allowed'],json.dumps(check,ensure_ascii=False)
        assert check['resume']['completedTaskIds']==['write-docx'] and check['unknownOperationCount']==0
        s['recoveryCheck']=check; save()
        result=api('/runs/'+s['runId']+'/retry',{'resume':True},label='resume-word')
        s['resumedRunId']=result['id']; save(); print(json.dumps(result))
    elif mode == 'run-status':
        run=api('/runs/'+s.get('resumedRunId',s['runId'])+'?limit=1')
        usage=[u for u in api('/usage') if u.get('projectId')==s['projectId']]
        print(json.dumps({'id':run['id'],'status':run['status'],'error':run.get('error'),'events':run['eventCount'],'summary':[e for e in run.get('summaryEvents',[]) if e['type'] not in ['team/snapshot','team/checkpoint']][-1:],'modelCalls':len(usage),'cost':sum(u['cost'] for u in usage)},ensure_ascii=False))
    elif mode == 'inspect-failure':
        run=api('/runs/'+s['resumedRunId']+'/export'); check=api('/runs/'+s['resumedRunId']+'/recovery-check')
        print(json.dumps({'check':check,'events':[{'type':e['type'],'data':e['data']} for e in run['events'] if e['type'] in ['context/compacted','runtime/anomaly','budget/stopped','run/finished']][-6:], 'files':api('/runs/'+s['resumedRunId']+'/artifacts')},ensure_ascii=False))
    elif mode in ['context-proposal', 'context-proposal-117k']:
        money_check(); check=api('/runs/'+s['resumedRunId']+'/recovery-check')
        assert set(check['resume']['completedTaskIds'])=={'write-docx','qa-verify'} and check['unknownOperationCount']==0
        # Model's known context ceiling is 131072; 118000 + 8192 + 1024 stays within it.
        # Four remaining requests and planning must fit the unchanged 0.26 via server admission.
        context=117000 if mode=='context-proposal-117k' else 118000
        if mode=='context-proposal-117k':
            prior=s['requests']['context-resource-proposal']
            assert prior['status']=='rejected' and 'RESOURCE_BUDGET_INSUFFICIENT' in prior['result']['response']
            # Exact archived overhead 7152 bytes: four full requests + .006 planning
            # + .063732 recorded costs = .2592648, within the existing .26 cap.
            assert check['costReadiness']['recordedCost']==.063732
        body={'modelId':MODEL,'maxBudget':.26,'maxPlanningCost':.006,'maxModelCalls':48,'maxTaskModelCalls':24,'contextBytes':context,'taskContinuationLimits':{'manager-accept':4}}
        result=api('/runs/'+s['resumedRunId']+'/resource-proposal',body,label='context-resource-proposal' if mode=='context-proposal' else mode)
        s['contextProposal']=result;save();print(json.dumps(result,ensure_ascii=False))
    elif mode == 'resume-context':
        money_check(); proposal=s['contextProposal'];assert proposal['proposal']['maxBudget']<=.26
        result=api('/runs/'+s['resumedRunId']+'/retry',{'resume':True,'budgetPreviewId':proposal['previewId'],'confirmation':'APPROVE_RESOURCES_AND_RESUME'},label='resume-context')
        s['contextParentRunId']=s['resumedRunId'];s['resumedRunId']=result['id'];save();print(json.dumps(result))
    elif mode == 'status':
        print(json.dumps({'requests': {k: {'status': v['status'], 'result': v.get('result')} for k, v in s['requests'].items()}, 'money': money_check()}, ensure_ascii=False))
    elif mode in ['correct-word', 'correct-word-2', 'correct-word-3']:
        raise RuntimeError('Completed corrections frozen after review; original records preserved')
        check = money_check(); previous = s['plans']['word'] if mode == 'correct-word' else s['plans']['wordCorrection']
        assert previous.get('draftIssue') and not previous.get('previewId')
        assert mode not in s['requests']
        # Correction belongs to the approved execution/correction allocation, not the 3 scenario calls.
        # Reserve 0.02 of its 0.28 for this one bounded discussion; execution cap is 0.26.
        policy = copy.deepcopy(s['policy']); policy['maxBudget'] = .26
        messages = [{'role': 'user', 'content': s['prompts']['word']}, {'role': 'assistant', 'content': previous['reply']},
          {'role': 'user', 'content': '请修正上一轮具体校验问题：' + previous['draftIssue']['message'] + '。deliveryCriteria只列用户报告的事实与独立核对要求；作者报告由QA检查，QA结果可由经理检查。最终经理验收单是检查结论，不再另造需要检查自身的交付标准（检查任务不得等于产出任务），不要添加无限自检链。保持原三人三节点、权限和业务事实。纠正预算从项目原0.28内预留0.02，实际执行最高0.26美元，其余上限不变。返回完整精简候选，不执行。'}]
        if mode != 'correct-word':
            pre = json.loads((ROOT / 'preflight.json').read_text())
            old = next(p for p in pre['projects'] if p['id'] == '5b0f9606-859f-4c63-96b3-4e7e0d7412ec')
            reference = [{k: v for k, v in t.items() if k not in ['estimatedInputTokens', 'estimatedOutputTokens', 'maxModelCalls']} for t in old['plan']['tasks']]
            messages[-1]['content'] += '\n参考下列同部门旧项目已通过的文件合同结构（仅结构参考，不能复用旧产物冒充本次工作）。请自主规划本次完整候选，outputs、inputs、producerTaskId必须逐字一致，保留经理/QA均为work；不要将office工作标成代码review。资源仍由你在0.26内分配，建议每人10~14次、单次8192足够交接。参考：' + json.dumps(reference, ensure_ascii=False)
        result = api('/organizations/chat', {'organizationRouting': True, 'conversationId': s['conversations']['word'], 'modelId': MODEL, 'templateId': 'software', 'policy': policy, 'messages': messages, 'previousDraftIssue': previous['draftIssue']}, label=mode)
        s['plans']['wordCorrection'] = result; s['executionPolicy'] = policy
        s['lastMoney'] = money_check(); save()
        print(json.dumps({'result': result, 'money': s['lastMoney']}, ensure_ascii=False))
    else:
        raise RuntimeError('Unknown mode')
