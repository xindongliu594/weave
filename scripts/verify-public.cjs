const {chromium}=require('../apps/desktop/node_modules/playwright');
const fs=require('node:fs');const assert=require('node:assert/strict');
(async()=>{const access=JSON.parse(fs.readFileSync('.data/deployment/access.json','utf8'));const browser=await chromium.launch({channel:'chrome',headless:true});
 try{const context=await browser.newContext({httpCredentials:{username:access.username,password:access.password},viewport:{width:1440,height:1000}});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const url=access.url.replace(/\/*$/,'/');
  for(const [hash,text] of [['knowledge','Obsidian Vault'],['settings','设置与数据管理'],['departments','部门与员工'],['run','执行']]){await page.goto(url+'#'+hash);await page.getByText(text,{exact:false}).first().waitFor();if(hash==='settings'){await page.getByRole('button',{name:'保存策略',exact:true}).waitFor();await page.getByText('就绪',{exact:true}).waitFor();}if(hash==='departments'){const before=(await (await context.request.get(url+'api/departments')).json()).length;await page.getByRole('textbox',{name:'需求',exact:true}).fill('整理现有产品资料，分析需求，独立审查并给出最终总结');await page.getByRole('button',{name:'生成模板草案',exact:true}).click();const editor=page.getByRole('textbox',{name:'组织与任务 DAG 草案（可编辑 JSON）',exact:true});await editor.waitFor();const candidate=JSON.parse(await editor.inputValue());assert.ok(candidate.tasks.length>1);assert.ok(candidate.tasks.at(-1).dependencies.length);assert.equal((await (await context.request.get(url+'api/departments')).json()).length,before);}
  if(hash==='knowledge')await page.getByRole('button',{name:'公司知识库',exact:true}).waitFor();await page.screenshot({path:'dist/public-'+hash+'.png',fullPage:true});console.log('Page verified:',hash);}
  const projects=await (await context.request.get(url+'api/projects')).json();
  if(projects.length){
   await page.getByRole('button',{name:'项目与方案',exact:true}).click();await page.locator('.project-row').first().click();
   await page.getByRole('heading',{name:'批准后可用的资料',exact:true}).waitFor();
   await page.getByRole('button',{name:'编辑方案',exact:true}).click();
   await page.getByRole('combobox',{name:'长期知识资料',exact:true}).waitFor();
   await page.getByRole('button',{name:'添加本次资料',exact:true}).waitFor();
   await page.screenshot({path:'dist/public-run-inputs.png',fullPage:true});
   const after=await (await context.request.get(url+'api/projects')).json();assert.deepEqual(after.map(p=>[p.id,p.version]),projects.map(p=>[p.id,p.version]));console.log('Public run input editor verified without changing any project.');
  }
  const health=await context.request.get(url+'api/health');assert.equal(health.status(),200);assert.equal((await health.json()).version,'0.2.0');
  const vault=await context.request.get(url+'api/knowledge/vault');assert.equal((await vault.json()).mode,'obsidian-markdown');
  const retrieval=await (await context.request.get(url+'api/knowledge/retrieval')).json();
  assert.equal(retrieval.mode,'hybrid');assert.equal(retrieval.installed,true);assert.equal(retrieval.error,null);assert.equal(retrieval.indexed,retrieval.total);
  console.log('Public local semantic index verified:',retrieval.indexed,'/',retrieval.total);
  const denied=await context.request.post(url+'api/knowledge/vault/sync',{data:{},headers:{Origin:'https://untrusted.invalid','Sec-Fetch-Site':'cross-site'}});assert.equal(denied.status(),403);
  for(const path of ['','admin/','portal/']){const r=await context.request.get('https://47.88.76.167/'+path);assert.equal(r.status(),200);}
  for(const name of ['win-x64.exe','win-x64.zip','mac-arm64.dmg','mac-x64.dmg']){const r=await context.request.head(url+'downloads/Agent-Department-0.2.0-'+name);assert.equal(r.status(),200);assert.ok(Number(r.headers()['content-length'])>1000000);}
  const anonymous=await browser.newContext();assert.equal((await anonymous.request.get(url+'api/health')).status(),401);await anonymous.close();
  assert.deepEqual(errors,[]);console.log('Public v0.2 health, Vault, browser rendering and existing AI-Mortgage routes verified.');
 }finally{await browser.close();}})().catch(e=>{console.error(e.message);process.exitCode=1;});
