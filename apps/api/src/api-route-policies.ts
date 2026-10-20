import {readFileSync} from 'node:fs';
import {METHODS} from 'node:http';
import ts from 'typescript';

export type RouteAccess = 'admin' | 'device';
export type RoutePolicy = { method:string; path:string; access:RouteAccess; source:string };
export const routePolicies:readonly RoutePolicy[] = [
  {method:'GET',path:'/api/activity',access:'admin',source:'app.ts'},
  {method:'GET',path:'/api/approvals',access:'admin',source:'run-management.ts'},
  {method:'POST',path:'/api/approvals/:id',access:'admin',source:'run-management.ts'},
  {method:'GET',path:'/api/automation/improvements',access:'admin',source:'automation-learning.ts'},
  {method:'POST',path:'/api/automation/improvements',access:'admin',source:'automation-learning.ts'},
  {method:'POST',path:'/api/automation/improvements/:id/evaluate',access:'admin',source:'automation-learning.ts'},
  {method:'GET',path:'/api/automation/improvements/:id/history',access:'admin',source:'automation-learning.ts'},
  {method:'POST',path:'/api/automation/improvements/:id/review',access:'admin',source:'automation-learning.ts'},
  {method:'GET',path:'/api/automation/knowledge-candidates',access:'admin',source:'automation-learning.ts'},
  {method:'POST',path:'/api/automation/knowledge-candidates',access:'admin',source:'automation-learning.ts'},
  {method:'PUT',path:'/api/automation/knowledge-candidates/:id',access:'admin',source:'automation-learning.ts'},
  {method:'POST',path:'/api/automation/knowledge-candidates/:id/publish',access:'admin',source:'automation-learning.ts'},
  {method:'GET',path:'/api/automation/knowledge-sources',access:'admin',source:'automation-learning.ts'},
  {method:'GET',path:'/api/automation/notifications',access:'admin',source:'automation-learning.ts'},
  {method:'POST',path:'/api/automation/notifications/:id/read',access:'admin',source:'automation-learning.ts'},
  {method:'GET',path:'/api/automation/observations',access:'admin',source:'automation-learning.ts'},
  {method:'GET',path:'/api/automation/occurrences',access:'admin',source:'automation-learning.ts'},
  {method:'GET',path:'/api/automation/schedules',access:'admin',source:'automation-learning.ts'},
  {method:'POST',path:'/api/automation/schedules',access:'admin',source:'automation-learning.ts'},
  {method:'POST',path:'/api/automation/schedules/:id/state',access:'admin',source:'automation-learning.ts'},
  {method:'GET',path:'/api/automation/status',access:'admin',source:'automation-learning.ts'},
  {method:'POST',path:'/api/backup/export',access:'admin',source:'backup.ts'},
  {method:'POST',path:'/api/backup/restore',access:'admin',source:'backup.ts'},
  {method:'GET',path:'/api/capabilities/plugins',access:'admin',source:'native-capabilities.ts'},
  {method:'PUT',path:'/api/capabilities/plugins/:id',access:'admin',source:'native-capabilities.ts'},
  {method:'GET',path:'/api/costs',access:'admin',source:'cost-router.ts'},
  {method:'POST',path:'/api/costs/:id/query-provider',access:'admin',source:'cost-router.ts'},
  {method:'POST',path:'/api/costs/:id/reconcile',access:'admin',source:'cost-router.ts'},
  {method:'GET',path:'/api/department-workbench',access:'admin',source:'department-workbench.ts'},
  {method:'GET',path:'/api/departments',access:'admin',source:'app.ts'},
  {method:'POST',path:'/api/departments',access:'admin',source:'app.ts'},
  {method:'DELETE',path:'/api/departments/:id',access:'admin',source:'app.ts'},
  {method:'PUT',path:'/api/departments/:id',access:'admin',source:'app.ts'},
  {method:'GET',path:'/api/departments/:id/removed-employees',access:'admin',source:'employee-history.ts'},
  {method:'POST',path:'/api/departments/:id/restore',access:'admin',source:'product.ts'},
  {method:'POST',path:'/api/departments/:id/restore-employee',access:'admin',source:'employee-history.ts'},
  {method:'GET',path:'/api/departments/:id/versions',access:'admin',source:'product.ts'},
  {method:'GET',path:'/api/departments/archived',access:'admin',source:'product.ts'},
  {method:'GET',path:'/api/diagnostics',access:'admin',source:'run-management.ts'},
  {method:'GET',path:'/api/gateways',access:'admin',source:'app.ts'},
  {method:'POST',path:'/api/gateways',access:'admin',source:'app.ts'},
  {method:'PUT',path:'/api/gateways/:id',access:'admin',source:'app.ts'},
  {method:'POST',path:'/api/gateways/:id/billing-check',access:'admin',source:'app.ts'},
  {method:'POST',path:'/api/gateways/:id/discover',access:'admin',source:'app.ts'},
  {method:'POST',path:'/api/gateways/:id/test',access:'admin',source:'app.ts'},
  {method:'GET',path:'/api/health',access:'admin',source:'app.ts'},
  {method:'GET',path:'/api/knowledge/documents',access:'admin',source:'knowledge.ts'},
  {method:'POST',path:'/api/knowledge/documents',access:'admin',source:'knowledge.ts'},
  {method:'DELETE',path:'/api/knowledge/documents/:id',access:'admin',source:'knowledge.ts'},
  {method:'PUT',path:'/api/knowledge/documents/:id',access:'admin',source:'knowledge.ts'},
  {method:'GET',path:'/api/knowledge/documents/:id/versions',access:'admin',source:'knowledge.ts'},
  {method:'POST',path:'/api/knowledge/index',access:'admin',source:'knowledge.ts'},
  {method:'GET',path:'/api/knowledge/retrieval',access:'admin',source:'knowledge.ts'},
  {method:'PUT',path:'/api/knowledge/retrieval',access:'admin',source:'knowledge.ts'},
  {method:'GET',path:'/api/knowledge/reuse',access:'admin',source:'knowledge.ts'},
  {method:'POST',path:'/api/knowledge/search',access:'admin',source:'knowledge.ts'},
  {method:'GET',path:'/api/knowledge/spaces',access:'admin',source:'knowledge.ts'},
  {method:'POST',path:'/api/knowledge/spaces',access:'admin',source:'knowledge.ts'},
  {method:'DELETE',path:'/api/knowledge/spaces/:id',access:'admin',source:'knowledge.ts'},
  {method:'GET',path:'/api/knowledge/vault',access:'admin',source:'obsidian.ts'},
  {method:'POST',path:'/api/knowledge/vault/sync',access:'admin',source:'obsidian.ts'},
  {method:'GET',path:'/api/knowledge/work-records',access:'admin',source:'knowledge.ts'},
  {method:'GET',path:'/api/knowledge/work-records/:id',access:'admin',source:'knowledge.ts'},
  {method:'POST',path:'/api/knowledge/work-records/:id/publish',access:'admin',source:'knowledge.ts'},
  {method:'GET',path:'/api/local-devices',access:'admin',source:'local-execution.ts'},
  {method:'DELETE',path:'/api/local-devices/:id',access:'admin',source:'local-execution.ts'},
  {method:'POST',path:'/api/local-devices/:id/disable',access:'device',source:'local-execution.ts'},
  {method:'POST',path:'/api/local-devices/:id/operations/:operation/result',access:'device',source:'local-execution.ts'},
  {method:'POST',path:'/api/local-devices/:id/operations/:operation/start',access:'device',source:'local-execution.ts'},
  {method:'POST',path:'/api/local-devices/:id/poll',access:'device',source:'local-execution.ts'},
  {method:'POST',path:'/api/local-devices/register',access:'admin',source:'local-execution.ts'},
  {method:'GET',path:'/api/models',access:'admin',source:'app.ts'},
  {method:'POST',path:'/api/models',access:'admin',source:'app.ts'},
  {method:'PUT',path:'/api/models/:id',access:'admin',source:'app.ts'},
  {method:'GET',path:'/api/models/:id/capability-tests',access:'admin',source:'app.ts'},
  {method:'POST',path:'/api/models/:id/test',access:'admin',source:'app.ts'},
  {method:'POST',path:'/api/models/:id/test-tools',access:'admin',source:'app.ts'},
  {method:'GET',path:'/api/openrig/projects',access:'admin',source:'openrig-router.ts'},
  {method:'GET',path:'/api/openrig/status',access:'admin',source:'openrig-router.ts'},
  {method:'POST',path:'/api/organizations',access:'admin',source:'product.ts'},
  {method:'POST',path:'/api/organizations/chat',access:'admin',source:'organization-chat.ts'},
  {method:'POST',path:'/api/organizations/preview',access:'admin',source:'product.ts'},
  {method:'POST',path:'/api/organizations/previews/:id/confirm',access:'admin',source:'product.ts'},
  {method:'GET',path:'/api/projects',access:'admin',source:'app.ts'},
  {method:'POST',path:'/api/projects',access:'admin',source:'app.ts'},
  {method:'POST',path:'/api/projects/:id/approve',access:'admin',source:'app.ts'},
  {method:'GET',path:'/api/projects/:id/cost-readiness',access:'admin',source:'app.ts'},
  {method:'POST',path:'/api/projects/:id/generate',access:'admin',source:'app.ts'},
  {method:'POST',path:'/api/projects/:id/generated-plan/confirm',access:'admin',source:'app.ts'},
  {method:'GET',path:'/api/projects/:id/knowledge-options',access:'admin',source:'app.ts'},
  {method:'GET',path:'/api/projects/:id/messages',access:'admin',source:'manager-chat.ts'},
  {method:'POST',path:'/api/projects/:id/messages',access:'admin',source:'manager-chat.ts'},
  {method:'DELETE',path:'/api/projects/:id/messages/:messageId',access:'admin',source:'manager-chat.ts'},
  {method:'GET',path:'/api/projects/:id/openrig',access:'admin',source:'openrig-router.ts'},
  {method:'POST',path:'/api/projects/:id/openrig/sync',access:'admin',source:'openrig-router.ts'},
  {method:'PUT',path:'/api/projects/:id/plan',access:'admin',source:'app.ts'},
  {method:'GET',path:'/api/projects/:id/planning-quote',access:'admin',source:'app.ts'},
  {method:'POST',path:'/api/projects/:id/planning-quote',access:'admin',source:'app.ts'},
  {method:'GET',path:'/api/projects/:id/versions',access:'admin',source:'app.ts'},
  {method:'GET',path:'/api/runs',access:'admin',source:'app.ts'},
  {method:'GET',path:'/api/runs/:id',access:'admin',source:'app.ts'},
  {method:'GET',path:'/api/runs/:id/artifact',access:'admin',source:'run-management.ts'},
  {method:'GET',path:'/api/runs/:id/artifacts',access:'admin',source:'run-management.ts'},
  {method:'POST',path:'/api/runs/:id/cancel',access:'admin',source:'app.ts'},
  {method:'GET',path:'/api/runs/:id/citations/:chunkId',access:'admin',source:'run-management.ts'},
  {method:'GET',path:'/api/runs/:id/export',access:'admin',source:'run-management.ts'},
  {method:'GET',path:'/api/runs/:id/lineage-evidence',access:'admin',source:'run-lineage-evidence.ts'},
  {method:'GET',path:'/api/runs/:id/local-operations',access:'admin',source:'local-execution.ts'},
  {method:'GET',path:'/api/runs/:id/recovery-check',access:'admin',source:'run-management.ts'},
  {method:'POST',path:'/api/runs/:id/resource-proposal',access:'admin',source:'recovery-resource-router.ts'},
  {method:'POST',path:'/api/runs/:id/retry',access:'admin',source:'run-management.ts'},
  {method:'POST',path:'/api/runs/:id/task-stops/reconcile',access:'admin',source:'task-stop-maintenance.ts'},
  {method:'POST',path:'/api/runs/verify',access:'admin',source:'app.ts'},
  {method:'POST',path:'/api/sandbox/install',access:'admin',source:'run-management.ts'},
  {method:'GET',path:'/api/settings',access:'admin',source:'product.ts'},
  {method:'PUT',path:'/api/settings',access:'admin',source:'product.ts'},
  {method:'GET',path:'/api/storage',access:'admin',source:'storage-governance.ts'},
  {method:'GET',path:'/api/storage/cleanups',access:'admin',source:'storage-governance.ts'},
  {method:'POST',path:'/api/storage/cleanups/:id/confirm',access:'admin',source:'storage-governance.ts'},
  {method:'POST',path:'/api/storage/cleanups/:id/reconcile',access:'admin',source:'storage-governance.ts'},
  {method:'POST',path:'/api/storage/preview',access:'admin',source:'storage-governance.ts'},
  {method:'GET',path:'/api/storage/retention',access:'admin',source:'storage-governance.ts'},
  {method:'GET',path:'/api/storage/sandboxes',access:'admin',source:'storage-governance.ts'},
  {method:'POST',path:'/api/storage/sandboxes/:id/inspect',access:'admin',source:'storage-governance.ts'},
  {method:'GET',path:'/api/templates',access:'admin',source:'product.ts'},
  {method:'POST',path:'/api/templates',access:'admin',source:'product.ts'},
  {method:'DELETE',path:'/api/templates/:id',access:'admin',source:'product.ts'},
  {method:'GET',path:'/api/usage',access:'admin',source:'app.ts'},
  {method:'GET',path:'/api/work-files',access:'admin',source:'work-files.ts'},
  {method:'POST',path:'/api/work-files',access:'admin',source:'work-files.ts'},
  {method:'GET',path:'/api/work-files/:id',access:'admin',source:'work-files.ts'},
  {method:'GET',path:'/api/work-files/:id/files/:index/download',access:'admin',source:'work-files.ts'},
  {method:'POST',path:'/api/work-files/from-run',access:'admin',source:'work-files.ts'},
  {method:'POST',path:'/api/work-files/generate',access:'admin',source:'work-files.ts'},
  {method:'GET',path:'/api/work-tools/browser',access:'admin',source:'work-tools-browser.ts'},
  {method:'POST',path:'/api/work-tools/browser',access:'admin',source:'work-tools-browser.ts'},
  {method:'DELETE',path:'/api/work-tools/browser/:id',access:'admin',source:'work-tools-browser.ts'},
  {method:'POST',path:'/api/work-tools/browser/:id/action',access:'admin',source:'work-tools-browser.ts'},
  {method:'GET',path:'/api/work-tools/mcp',access:'admin',source:'work-tools-browser.ts'},
  {method:'POST',path:'/api/work-tools/mcp',access:'admin',source:'work-tools-browser.ts'},
  {method:'PUT',path:'/api/work-tools/mcp/:id',access:'admin',source:'work-tools-browser.ts'},
  {method:'POST',path:'/api/work-tools/mcp/:id/call',access:'admin',source:'work-tools-browser.ts'},
  {method:'POST',path:'/api/work-tools/mcp/:id/discover',access:'admin',source:'work-tools-browser.ts'},
];

const methods=new Set(METHODS.map(method=>method.toLowerCase()));
const unsupportedMethods=new Set(['all','route']);
const validPath=/^\/api\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/;
const matchingPolicies=[...routePolicies].sort((a,b)=>b.path.split('/').filter(x=>!x.startsWith(':')).length-a.path.split('/').filter(x=>!x.startsWith(':')).length);

export function routePolicy(method:string,path:string):RoutePolicy|null {
  if(!validPath.test(path)||!['GET','POST','PUT','PATCH','DELETE'].includes(method))return null;
  // Literal routes win over parameters, mirroring the registration order of
  // overlapping business endpoints without broadening the accepted URL.
  for(const policy of matchingPolicies){
    if(policy.method!==method)continue;
    const names=policy.path.split('/'),parts=path.split('/');
    if(parts.length===names.length&&names.every((part,index)=>part.startsWith(':')?parts[index].length>0:part===parts[index]))return policy;
  }
  return null;
}

const authEntries=new Set(['GET /auth/session','POST /auth/login','GET /auth/callback','POST /auth/logout']);
export function isClassifiedEntry(method:string,path:string):boolean {
  return (method==='GET'&&path==='/healthz')||authEntries.has(`${method} ${path}`)||routePolicy(method,path)!==null;
}

/** Parse every currently reachable route source; unfamiliar registration syntax is a startup error. */
export function actualRouteRegistrations():string[] {
  const found:string[]=[];
  const authFound:string[]=[];
  for(const source of reachableRouteSources){
    const code=readFileSync(new URL(source,new URL('.',import.meta.url)),'utf8');
    const ast=ts.createSourceFile(source,code,ts.ScriptTarget.Latest,true);
    const visit=(node:ts.Node):void=>{
      if(ts.isCallExpression(node)&&ts.isElementAccessExpression(node.expression)&&['app','router'].includes(node.expression.expression.getText(ast)))
        throw Error('Unsupported computed Express registration in '+source);
      if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)){
        const method=node.expression.name.text,owner=node.expression.expression.getText(ast);
        const first=node.arguments[0],path=first&&ts.isStringLiteral(first)?first.text:null;
        if((owner==='app'||owner==='router')&&node.expression.questionDotToken)
          throw Error('Unsupported optional Express registration in '+source);
        if((owner==='app'||owner==='router')&&unsupportedMethods.has(method))
          throw Error('Unsupported Express registration style in '+source);
        // This is a deliberately finite source inventory, not a JavaScript
        // interpreter. A path-bearing registration must use a reviewed verb
        // or the separately checked middleware mount syntax.
        if((owner==='app'||owner==='router')&&path?.startsWith('/')&&method!=='use'&&!methods.has(method))
          throw Error('Unsupported Express registration name in '+source);
        if(methods.has(method)){
          if(owner==='app'||owner==='router'){
            if(path===null)throw Error('Nonliteral Express route in '+source);
            if(source==='identity-http.ts'&&owner==='router'){
              const entry=`${method.toUpperCase()} ${path}`;
              if(!authEntries.has(entry))throw Error('Unclassified identity route in '+source);
              authFound.push(entry);
            }else if(owner==='app'&&path==='/healthz'){
              if(method!=='get')throw Error('Invalid public liveness route');
            }else if(method!=='get'&&method!=='post'&&method!=='put'&&method!=='patch'&&method!=='delete')
              throw Error('Unclassified Express HTTP method in '+source);
            else if(owner==='app'&&path.startsWith('/api/'))found.push(`${method.toUpperCase()} ${path}`);
            else if(owner==='router'&&path.startsWith('/'))found.push(`${method.toUpperCase()} /api${path}`);
            else throw Error('Business route outside the protected API in '+source);
          }else if(path?.startsWith('/'))throw Error('Unsupported Express route owner in '+source);
        }
      }
      ts.forEachChild(node,visit);
    };visit(ast);
  }
  if(JSON.stringify(authFound.sort())!==JSON.stringify([...authEntries].sort()))
    throw Error('Identity routes do not match classified entries');
  return found.sort();
}

const mountedRouters=['managerChatRouter','browserMcpRouter','nativeCapabilityRouter','workFilesRouter',
  'automationLearningRouter','localDeviceRouter','obsidianRouter','knowledgeRouter','productRouter',
  'employeeHistoryRouter','departmentWorkbenchRouter','openRigRouter','runLineageEvidenceRouter','taskStopMaintenanceRouter',
  'costRouter','runManagementRouter','backupRouter','storageRouter'];
const expectedNestedMounts:Record<string,string[]>={
  'product.ts':['organizationChatRouter'],
  'run-management.ts':['recoveryResourceRouter'],
  'identity-http.ts':['anonymous'],
};
const reachableRouteSources=new Set([...routePolicies.map(entry=>entry.source),'identity-http.ts']);

function useRegistrations(source:string):string[] {
  const code=readFileSync(new URL(source,new URL('.',import.meta.url)),'utf8');
  const ast=ts.createSourceFile(source,code,ts.ScriptTarget.Latest,true),found:string[]=[];
  const visit=(node:ts.Node):void=>{
    if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='use'){
      const owner=node.expression.expression.getText(ast);
      if(owner==='app'||owner==='router'){
        const first=node.arguments[0],prefix=first&&ts.isStringLiteral(first)?first.text:'';
        const handlers=node.arguments.slice(prefix?1:0);
        if(!handlers.length)throw Error('Missing Express middleware in '+source);
        for(const handler of handlers){
          let name:string;
          if(ts.isSpreadElement(handler)||ts.isArrayLiteralExpression(handler))throw Error('Unsupported Express middleware list in '+source);
          if(ts.isCallExpression(handler))name=handler.expression.getText(ast);
          else if(ts.isArrowFunction(handler)||ts.isFunctionExpression(handler))name='anonymous';
          else if(ts.isIdentifier(handler)||ts.isPropertyAccessExpression(handler))name=handler.getText(ast);
          else throw Error('Unsupported Express middleware mount in '+source);
          found.push(`${owner} ${prefix||'(root)'} ${name}`);
        }
      }
    }
    ts.forEachChild(node,visit);
  };visit(ast);return found;
}

const expectedAppUses=[
  'app /api/backup/restore express.json','app /api/local-devices express.json','app /api/work-files express.json',
  'app (root) express.json',
  ...Array(3).fill('app (root) anonymous'),
  'app (root) identity.router',
  ...Array(2).fill('app (root) anonymous'),
  'app /api apiAccess','app /api idempotency',
  ...mountedRouters.map(name=>`app /api ${name}`),
  ...Array(2).fill('app (root) anonymous'),
];
expectedAppUses.unshift('app (root) anonymous');

export function assertRouteInventory():void {
  const expected=routePolicies.map(entry=>`${entry.method} ${entry.path}`).sort();
  const actual=actualRouteRegistrations();
  if(new Set(expected).size!==expected.length||JSON.stringify(actual)!==JSON.stringify(expected))
    throw Error('Business route registration does not match the explicit access catalog');
  for(let index=0;index<routePolicies.length;index++)for(let other=index+1;other<routePolicies.length;other++){
    const left=routePolicies[index],right=routePolicies[other];
    if(left.method!==right.method)continue;
    const a=left.path.split('/'),b=right.path.split('/');
    if(a.length===b.length&&a.every((segment,i)=>segment===b[i]||segment.startsWith(':')||b[i].startsWith(':')))
      throw Error('Overlapping business route policies require explicit registration-order review');
  }
  if(JSON.stringify(useRegistrations('app.ts'))!==JSON.stringify(expectedAppUses)
    ||[...reachableRouteSources].filter(source=>source!=='app.ts').some(source=>
      JSON.stringify(useRegistrations(source))!==JSON.stringify((expectedNestedMounts[source]??[]).map(name=>`router (root) ${name}`))))
    throw Error('Business router mounts do not match the explicit access catalog');
}
