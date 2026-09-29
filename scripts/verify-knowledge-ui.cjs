// Built frontend, isolated HTTP fixture: no credentials, live data, or model calls.
const {chromium}=require('../apps/desktop/node_modules/playwright');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const {once}=require('node:events');

(async()=>{
 const root=path.resolve(__dirname,'../dist/web'),id='a1111111-1111-4111-8111-111111111111';
 const source={id:'chunk',chunkId:'chunk',documentId:'doc',title:'冻结的部门规范',version:3,lineStart:7,lineEnd:9,sha256:'a'.repeat(64),source:{vaultPath:'department/规范.md'},content:'原文：先执行部署验证。\n<script>window.unsafeCitation=true</script>'};
 const event={seq:1,at:new Date().toISOString(),type:'knowledge/citation',data:{agentId:'manager',sources:[source]}};
 const run={id,title:'知识引用界面验证',mode:'product',status:'completed',integrity:'ok',createdAt:new Date().toISOString(),events:[event],eventCount:1,hasMore:false,snapshot:{requirement:'核对历史原文',planVersion:1,templateVersion:'fixture',agents:[],tasks:[],knowledge:{format:'document-versions-v2',documents:[{documentId:'doc'}],agentDocuments:{manager:['doc']}}}};
 run.snapshot.policy={maxBudget:1,maxAgents:2,maxConcurrentAgents:1,deadlineSeconds:300,maxModelCalls:100,maxTaskModelCalls:40};run.snapshot.budgetVersion=1;
 run.events.push({seq:2,at:event.at,type:'budget/warning',data:{scope:'project',threshold:90,spent:.9,limit:1,calls:20,maxCalls:100}});
 const model={id:'model',name:'Fixture',model:'fixture',status:'available',gatewayId:'gateway',inputRate:1,outputRate:2};
 const agent={id:'manager',name:'经理',role:'manager',title:'经理',instructions:'协调任务',modelId:'model',tools:[]};
 const department={id:'department',name:'测试部门',description:'员工恢复界面测试',agents:[agent],version:3,createdAt:event.at,updatedAt:event.at,runCount:1};
 const removed={agent:{id:'analyst',name:'历史分析员',role:'member',title:'研究分析员',instructions:'查证资料并引用来源',systemConstraints:'不得猜测',outputFormat:'Markdown',modelId:'model',tools:['knowledge_search'],roleVersion:2},sourceVersion:2};
 let removedEmployees=[removed],restoredEmployee;
 const project={id:'project',departmentId:'department',departmentName:'测试部门',requirement:'预算表单测试需求',version:1,source:'manual',status:'DRAFT',createdAt:event.at,policy:run.snapshot.policy,planningCost:0,validation:{valid:true,estimate:.01,checks:[],errors:[]},plan:{rationale:'Fixture',agents:[agent],tasks:[{id:'task',subject:'测试任务',objective:'核对预算配置',assigneeId:'manager',dependencies:[],acceptanceCriteria:['预算保存正确'],estimatedInputTokens:10,estimatedOutputTokens:10}]}};
 let savedPlan,savedPolicy,reconciled,retrievalSaved,toolProbeRequest;
 const retrieval={mode:'keyword',version:1,installed:true,model:'Local fixture embedding',embeddingVersion:'fixture-v1',indexed:1,total:2,running:false,error:null};
 const costCall={id:'cost',modelName:'Fixture',purpose:'连接测试',amount:.5,inputRate:1,outputRate:2,status:'uncertain',createdAt:event.at,history:[]};
 const costs={timezone:'UTC',spent:.1,reserved:.5,calls:[costCall],recent:[],departments:[{id:'department',name:'测试部门',spent:.1,reserved:.5,limit:2}]};
 let missing=false;
 const server=http.createServer(async(req,res)=>{
  const pathname=new URL(req.url,'http://127.0.0.1').pathname,apiPath=pathname.replace(/^\/agent-department/,'');
  if(apiPath.startsWith('/api/')){
   res.setHeader('content-type','application/json');
   if(apiPath===`/api/runs/${id}/citations/chunk`){res.statusCode=missing?409:200;res.end(JSON.stringify(missing?{message:'运行引用的知识版本缺失或不完整'}:source));return;}
   if(apiPath==='/api/projects/project/plan'&&req.method==='PUT'){let body='';for await(const data of req)body+=data;savedPlan=JSON.parse(body).plan;savedPolicy=JSON.parse(body).policy;project.plan=savedPlan;project.policy=savedPolicy;res.end('{}');return;}
   if(apiPath==='/api/projects/project/knowledge-options'){res.end(JSON.stringify([{id:'doc1',title:'本次选用规范',version:1,agentIds:['manager']},{id:'doc2',title:'无需使用规范',version:2,agentIds:['manager']}]));return;}
   if(apiPath==='/api/departments/department/removed-employees'){res.end(JSON.stringify({departmentVersion:department.version,employees:removedEmployees}));return;}
   if(apiPath==='/api/departments/department/restore-employee'&&req.method==='POST'){let body='';for await(const data of req)body+=data;restoredEmployee=JSON.parse(body);removedEmployees=[];department.version++;department.agents.push({...removed.agent,role:restoredEmployee.role,roleVersion:3});res.end(JSON.stringify({ok:true,version:department.version,agent:department.agents.at(-1)}));return;}
   if(apiPath==='/api/models/model/test-tools'){let body='';for await(const data of req)body+=data;toolProbeRequest=JSON.parse(body);model.capabilities={tools:{status:'supported',checkedAt:event.at,testId:'probe-fixture',probeVersion:'chat-tools-roundtrip-v1'}};res.end(JSON.stringify({message:'工具参数和工具结果往返测试通过；用量已记录。'}));return;}
   if(apiPath==='/api/models/model/capability-tests'){res.end(JSON.stringify([{id:'probe-fixture',createdAt:event.at,status:'supported',modelVersion:1,requestIds:['first','second'],probeVersion:'chat-tools-roundtrip-v1'}]));return;}
   if(apiPath==='/api/costs/cost/reconcile'&&req.method==='POST'){let body='';for await(const data of req)body+=data;reconciled=JSON.parse(body);costs.calls=[];costs.reserved=0;costs.recent=[{...costCall,status:'settled',history:[{source:'manual',...reconciled}]}];res.end('{}');return;}
   if(apiPath==='/api/costs'){res.end(JSON.stringify(costs));return;}
   if(apiPath==='/api/settings'){res.end(JSON.stringify({data:{autoBudgetLimit:.25,dailyBudgetLimit:20,maxActiveRuns:2}}));return;}
   if(apiPath==='/api/diagnostics'){res.end(JSON.stringify({platform:'fixture',node:'fixture',sandbox:true,knowledge:1,worker:{}}));return;}
   if(apiPath==='/api/templates'){res.end(JSON.stringify({departments:[],roles:[]}));return;}
   if(apiPath==='/api/knowledge/retrieval'){
    if(req.method==='PUT'){let body='';for await(const data of req)body+=data;retrievalSaved=JSON.parse(body);retrieval.mode=retrievalSaved.mode;retrieval.version++;}
    res.end(JSON.stringify(retrieval));return;
   }
   if(apiPath==='/api/knowledge/index'){retrieval.indexed=retrieval.total;res.end('{}');return;}
   if(apiPath==='/api/knowledge/vault'){res.end(JSON.stringify({root:'/fixture/obsidian',instructions:'本地 Markdown Vault'}));return;}
   const value=apiPath==='/api/health'?{version:'fixture',runtime:{reason:'fixture'}}:apiPath==='/api/models'?[model]:apiPath==='/api/departments'?[department]:apiPath==='/api/departments/archived'?[]:apiPath==='/api/projects'?[project]:apiPath==='/api/runs'?[run]:apiPath===`/api/runs/${id}`?run:[];
   res.end(JSON.stringify(value));return;
  }
  const relative=pathname.replace(/^\/agent-department\/?/,'')||'index.html',file=path.resolve(root,relative);
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.statusCode=404;res.end();return;}
  res.setHeader('content-type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html');fs.createReadStream(file).pipe(res);
 });
 let browser;
 try{
  server.listen(0,'127.0.0.1');await once(server,'listening');
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/agent-department/#run/${id}`);
  await page.getByText('批准时已固定 1 份知识文档的版本',{exact:false}).waitFor();
  await page.getByRole('status').filter({hasText:'达到 90% 预算'}).waitFor();
  await page.getByText('知识引用（1）',{exact:true}).click();
  await page.getByRole('button',{name:'查看引用原文',exact:true}).click();
  await page.getByRole('heading',{name:'冻结的部门规范 · v3',exact:true}).waitFor();
  assert.ok((await page.locator('.knowledge-result pre').textContent()).includes('<script>'));
  assert.equal(await page.evaluate(()=>window.unsafeCitation),undefined);
  await page.screenshot({path:path.resolve(__dirname,'../dist/knowledge-citation-ui.png'),fullPage:true});
  await page.getByRole('button',{name:'关闭原文',exact:true}).click();
  missing=true;await page.getByRole('button',{name:'查看引用原文',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'运行引用的知识版本缺失或不完整'}).waitFor();
  await page.getByRole('button',{name:'项目与方案',exact:true}).click();
  await page.getByText(project.requirement,{exact:true}).click();
  await page.getByRole('button',{name:'编辑方案',exact:true}).click();
  await page.getByRole('checkbox',{name:'策略允许：知识检索',exact:true}).check();
  await page.getByRole('spinbutton',{name:'项目预算（USD）',exact:true}).fill('2');
  await page.getByRole('spinbutton',{name:'任务费用上限（USD，可选）',exact:false}).fill('0.25');
  await page.getByRole('spinbutton',{name:'任务调用次数上限（可选）',exact:false}).fill('12');
  await page.getByRole('combobox',{name:'长期知识资料',exact:true}).selectOption('selected');
  await page.getByRole('checkbox',{name:'本次选用规范',exact:false}).check();
  await page.getByRole('checkbox',{name:'知识检索',exact:true}).check();
  await page.getByRole('button',{name:'添加本次资料',exact:true}).click();
  await page.getByRole('textbox',{name:'资料标题',exact:true}).fill('本次会议记录');
  await page.getByRole('textbox',{name:'本次资料正文',exact:true}).fill('仅供本次分析使用的输入资料。');
  await page.getByRole('button',{name:'保存新版本',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'hidden'});
  assert.equal(savedPolicy.maxBudget,2);assert.deepEqual(savedPolicy.allowedTools,['knowledge_search']);assert.deepEqual(savedPolicy.allowedModelIds,['model']);assert.deepEqual(savedPolicy.allowedKnowledgeSpaceIds,[]);assert.equal(savedPlan.tasks[0].maxBudget,.25);assert.equal(savedPlan.tasks[0].maxModelCalls,12);
  assert.deepEqual(savedPlan.knowledgeDocumentIds,['doc1']);assert.equal(savedPlan.runInputs[0].content,'仅供本次分析使用的输入资料。');assert.deepEqual(savedPlan.runInputs[0].agentIds,['manager']);
  await page.getByText('本次会议记录 · 本次专用 · 经理',{exact:true}).click();
  await page.getByText('仅供本次分析使用的输入资料。',{exact:true}).waitFor();
  await page.screenshot({path:path.resolve(__dirname,'../dist/run-input-scope-ui.png'),fullPage:true});
  await page.goto(`http://127.0.0.1:${server.address().port}/agent-department/#departments`);
  await page.getByRole('heading',{name:'部门与员工',exact:true}).waitFor();
  await page.getByRole('button',{name:'恢复已移除员工 · 测试部门',exact:true}).click();
  await page.getByRole('button',{name:'查看并恢复 历史分析员',exact:true}).click();
  await page.getByText('查证资料并引用来源',{exact:true}).waitFor();
  await page.getByText('系统约束：不得猜测 · 输出规范：Markdown',{exact:true}).waitFor();
  await page.getByRole('button',{name:'确认恢复员工',exact:true}).click();
  await page.getByRole('status').filter({hasText:'员工已恢复'}).waitFor();
  assert.deepEqual(restoredEmployee,{agentId:'analyst',sourceVersion:2,departmentVersion:3,role:'member'});
  await page.getByText('没有可恢复的员工。',{exact:true}).waitFor();
  await page.screenshot({path:path.resolve(__dirname,'../dist/employee-restore-ui.png'),fullPage:true});
  await page.getByRole('button',{name:'系统设置',exact:true}).click();
  await page.getByText('费用待核对 · 预留 $0.500000',{exact:false}).waitFor();
  await page.getByRole('button',{name:'核对这次费用',exact:true}).click();
  const submit=page.getByRole('button',{name:'确认记录用量',exact:true});assert.equal(await submit.isDisabled(),true);
  await page.getByRole('spinbutton',{name:'账单输入 Token',exact:true}).fill('12');
  await page.getByRole('spinbutton',{name:'账单输出 Token',exact:true}).fill('34');
  await page.getByRole('textbox',{name:'核对依据',exact:true}).fill('测试账单编号 fixture-receipt');
  assert.equal(await submit.isDisabled(),true);
  await page.getByRole('checkbox',{name:'我已核对供应方账单，确认以上用量',exact:true}).check();
  await submit.click();await page.getByRole('status').filter({hasText:'费用已按请求时的单价核对'}).waitFor();
  assert.deepEqual(reconciled,{inputTokens:12,outputTokens:34,note:'测试账单编号 fixture-receipt',confirmation:'RECONCILE'});
  await page.getByText('没有进行中或待核对的调用。',{exact:true}).waitFor();
  await page.getByText('最近 20 次已结算或未发送的请求',{exact:true}).click();
  await page.getByText('Fixture · 连接测试 · 已结算',{exact:true}).click();
  assert.ok((await page.locator('.product-pre').allTextContents()).some(t=>t.includes('fixture-receipt')));
  await page.screenshot({path:path.resolve(__dirname,'../dist/cost-reconciliation-ui.png'),fullPage:true});
  await page.getByRole('button',{name:'知识库',exact:true}).click();
  await page.getByRole('heading',{name:'知识检索方式',exact:true}).waitFor();
  await page.getByRole('button',{name:'启用混合检索',exact:true}).click();
  await page.getByText('当前：关键词 + 本地语义混合检索',{exact:false}).waitFor();
  assert.deepEqual(retrievalSaved,{mode:'hybrid',version:1});
  await page.getByRole('button',{name:'补建语义索引',exact:true}).click();
  await page.getByText('已索引 2 / 2 个当前资料切片',{exact:false}).waitFor();
  await page.getByRole('button',{name:'使用关键词检索',exact:true}).click();
  await page.getByText('当前：关键词检索',{exact:false}).waitFor();
  assert.deepEqual(retrievalSaved,{mode:'keyword',version:2});
  await page.screenshot({path:path.resolve(__dirname,'../dist/hybrid-retrieval-ui.png'),fullPage:true});
  await page.getByRole('button',{name:'模型目录',exact:true}).click();
  await page.getByText('工具调用：尚未验证',{exact:true}).waitFor();
  await page.getByRole('spinbutton',{name:'工具测试费用上限（USD）',exact:true}).fill('0.05');
  await page.getByRole('button',{name:'测试工具能力',exact:true}).click();
  await page.getByText('工具调用：往返测试通过',{exact:true}).waitFor();assert.deepEqual(toolProbeRequest,{maxCost:.05});
  await page.getByRole('button',{name:'查看能力测试记录',exact:true}).click();
  await page.getByText('配置 v1 · 2 次请求 · chat-tools-roundtrip-v1',{exact:true}).waitFor();
  await page.screenshot({path:path.resolve(__dirname,'../dist/model-capabilities-ui.png'),fullPage:true});
  assert.deepEqual(errors,[]);console.log('Historical citations, escaped markup, budget forms, and explicit cost reconciliation verified in Chrome.');
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
