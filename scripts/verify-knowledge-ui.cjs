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
 run.snapshot.policy={maxBudget:1,maxModelCalls:100,maxTaskModelCalls:40};run.snapshot.budgetVersion=1;
 run.events.push({seq:2,at:event.at,type:'budget/warning',data:{scope:'project',threshold:90,spent:.9,limit:1,calls:20,maxCalls:100}});
 const model={id:'model',name:'Fixture',model:'fixture',status:'available',gatewayId:'gateway',inputRate:1,outputRate:2};
 const agent={id:'manager',name:'经理',role:'manager',title:'经理',instructions:'协调任务',modelId:'model',tools:[]};
 const project={id:'project',departmentId:'department',departmentName:'测试部门',requirement:'预算表单测试需求',version:1,source:'manual',status:'DRAFT',createdAt:event.at,policy:run.snapshot.policy,planningCost:0,validation:{valid:true,estimate:.01,checks:[],errors:[]},plan:{rationale:'Fixture',agents:[agent],tasks:[{id:'task',subject:'测试任务',objective:'核对预算配置',assigneeId:'manager',dependencies:[],acceptanceCriteria:['预算保存正确'],estimatedInputTokens:10,estimatedOutputTokens:10}]}};
 let savedPlan;
 let missing=false;
 const server=http.createServer(async(req,res)=>{
  const pathname=new URL(req.url,'http://127.0.0.1').pathname,apiPath=pathname.replace(/^\/agent-department/,'');
  if(apiPath.startsWith('/api/')){
   res.setHeader('content-type','application/json');
   if(apiPath===`/api/runs/${id}/citations/chunk`){res.statusCode=missing?409:200;res.end(JSON.stringify(missing?{message:'运行引用的知识版本缺失或不完整'}:source));return;}
   if(apiPath==='/api/projects/project/plan'&&req.method==='PUT'){let body='';for await(const data of req)body+=data;savedPlan=JSON.parse(body).plan;project.plan=savedPlan;res.end('{}');return;}
   const value=apiPath==='/api/health'?{version:'fixture',runtime:{reason:'fixture'}}:apiPath==='/api/models'?[model]:apiPath==='/api/projects'?[project]:apiPath==='/api/runs'?[run]:apiPath===`/api/runs/${id}`?run:[];
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
  await page.getByRole('spinbutton',{name:'任务费用上限（USD，可选）',exact:false}).fill('0.25');
  await page.getByRole('spinbutton',{name:'任务调用次数上限（可选）',exact:false}).fill('12');
  await page.getByRole('button',{name:'保存新版本',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'hidden'});
  assert.equal(savedPlan.tasks[0].maxBudget,.25);assert.equal(savedPlan.tasks[0].maxModelCalls,12);
  assert.deepEqual(errors,[]);console.log('Historical citations, escaped markup, errors, budget warning and task budget form verified in Chrome.');
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
