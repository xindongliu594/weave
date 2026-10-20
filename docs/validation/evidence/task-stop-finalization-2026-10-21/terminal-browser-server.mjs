import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {appendFileSync,writeFileSync} from 'node:fs';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const out=fileURLToPath(new URL('./terminal-browser-http.jsonl',import.meta.url));
const runId='10000000-0000-0000-0000-000000000001',other='10000000-0000-0000-0000-000000000009';
const key={runId,taskId:'qa',attemptId:'qa-attempt-1',generation:1};
const locator={key,sandboxId:'10000000-0000-0000-0000-000000000002',workspaceRevision:'a'.repeat(64)};
const stopId='10000000-0000-0000-0000-000000000003';
let mode='hold',stopped=false,pending=[],requests=0;
const json=(res,value,status=200)=>{res.statusCode=status;res.setHeader('content-type','application/json');res.end(JSON.stringify(value));};
const read=async(req)=>{let body='';for await(const chunk of req)body+=chunk;if(body.length>8192)throw Error('fixture request limit');return body?JSON.parse(body):{};};
function scope(id=runId){
 if(id===other)return {...locator,key:{...key,runId:other,taskId:'other-task'},state:'no-intent',reasonCode:'TASK_STOP_NO_INTENT',canReconcile:false};
 return {...locator,state:mode==='no-intent'?'no-intent':stopped?'stopped':'unknown',...(mode==='no-intent'?{reasonCode:'TASK_STOP_NO_INTENT'}:{stopId,...(!stopped?{reasonCode:'TASK_STOP_UNKNOWN'}:{})}),canReconcile:!stopped&&mode!=='no-intent'};
}
const projection=(id=runId)=>({version:1,state:id===runId&&stopped&&mode!=='no-intent'?'stopped':'pending',scopes:[scope(mode==='mismatch'?other:id)]});
function detail(id){
 return {id,title:'隔离验证：已验收项目的原停止结果核对',mode:'product',status:'completed',createdAt:'2026-10-21T01:00:00.000Z',eventCount:1,integrity:'ok',hasMore:false,nextCursor:1,
  snapshot:{id,requirement:'仅验证网页展示与点击；数据为虚构工程 fixture，不能作为真实员工或沙箱验收。',planVersion:1,templateVersion:1,executionProfile:'task-attempt-openshell-v1',agents:[],tasks:[],policy:{maxBudget:0.18,maxModelCalls:32,maxTaskModelCalls:16}},
  taskStopMaintenance:projection(id),recovery:{unknownOperations:[],costReadiness:{recordedCost:0,reserved:0,availableBudget:0.18,pendingCount:0,uncertainCount:0,receipts:[]}},
  events:[{seq:1,type:stopped?'runtime/maintenance-completed':'runtime/maintenance-pending',at:'2026-10-21T01:00:00.000Z',data:{message:'隔离网页测试数据'}}]};
}
const log=(req,extra={})=>appendFileSync(out,JSON.stringify({at:new Date().toISOString(),method:req.method,path:req.url,...extra})+'\n');
const server=await createServer({configFile:false,root:fileURLToPath(new URL('./',import.meta.url)),optimizeDeps:{entries:['terminal-browser-fixture.html'],noDiscovery:true,include:['react','react-dom/client','react/jsx-runtime','lucide-react','zod']},plugins:[react(),{name:'isolated-terminal-api',configureServer(server){server.middlewares.use(async(req,res,next)=>{
 try{
  const path=new URL(req.url,'http://127.0.0.1').pathname;
  if(path==='/__terminal_fixture/control'){const input=await read(req);for(const old of pending)json(old,{message:'fixture reset'},409);pending=[];mode=input.mode;stopped=false;requests=0;log(req,{mode});return json(res,{mode});}
  if(path==='/__terminal_fixture/release'){stopped=true;for(const old of pending)json(old,{maintenance:projection(),replayed:false});pending=[];log(req,{requests});return json(res,{requests});}
  if(path==='/__terminal_fixture/status')return json(res,{mode,stopped,requests,pending:pending.length});
  if(path==='/auth/session')return json(res,{mode:'legacy-local',authenticated:true,user:null,csrf:null,loginAvailable:false});
  if(!path.startsWith('/api/'))return next();
  log(req);
  const match=path.match(/^\/api\/runs\/([a-f0-9-]{36})(.*)$/);
  if(match?.[2]==='/task-stops/reconcile'){
   const body=await read(req);requests++;log(req,{body,requests});
   if(match[1]!==runId||JSON.stringify(body)!==JSON.stringify({...locator,stopId}))return json(res,{message:'fixture original locator mismatch'},409);
   if(mode==='denied')return json(res,{code:'TASK_STOP_DEVICE_CHANGED',message:'原设备授权已变化，请核对原设备和授权。'},409);
   if(mode==='hold'){pending.push(res);return;}
   return json(res,{maintenance:projection(),replayed:false});
  }
  if(req.method!=='GET')return json(res,{message:'fixture rejects other mutations'},405);
  if(path==='/api/runs')return json(res,[detail(runId),detail(other)]);
  if(match?.[2]==='')return json(res,detail(match[1]));
  if(path==='/api/storage/sandboxes')return json(res,{available:true,scopes:[
   {runId,scopeKind:'task',...locator,phase:'unknown',taskStopMaintenance:scope()},
   {runId:'legacy-fixture',sandboxId:'legacy-sandbox',phase:'ready',storage:{workspace:{bytes:24},temp:{bytes:0},checkedAt:'2026-10-21T01:00:00.000Z'}}]});
  if(path==='/api/storage')return json(res,{bytes:24,complete:true,groups:[],runs:[],disk:{blocked:false,freeBytes:1024**3}});
  if(path==='/api/storage/retention')return json(res,{policy:{hotJournalHours:24,completedCopiesDays:7,releaseKeepLatest:3,backupDays:7,backupKeepLatest:3},recommendations:[]});
  return json(res,[]);
 }catch(error){json(res,{message:String(error)},500);}
 });}}],server:{host:'127.0.0.1',port:4479,strictPort:true,fs:{allow:[root]},watch:{ignored:['**/.private/**','**/.superpowers/**']}}});
await server.listen();
const url='http://127.0.0.1:4479/terminal-browser-fixture.html#run/'+runId;
writeFileSync(resolve(root,'.superpowers/sdd/2026-10-20-task-checkpoint-v2-integration/terminal-browser-server-info.json'),JSON.stringify({pid:process.pid,url,fixture:'actual components; fixture transport; no paid model/production/device operations'},null,2));
console.log(JSON.stringify({pid:process.pid,url}));
process.once('SIGINT',async()=>{for(const res of pending)json(res,{message:'fixture shutdown'},409);await server.close();process.exit(0);});
