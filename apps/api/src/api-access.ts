import type {RequestHandler} from 'express';
import type {Principal,IdentityConfig} from './identity-types.ts';
import type {createIdentityHttp} from './identity-http.ts';
import {routePolicy,type RoutePolicy} from './api-route-policies.ts';
import {proveLocalDevice} from './local-execution.ts';
import {pool} from './db.ts';
import {currentRoutePrincipal,requireProjectRoute,requireRunRoute,requireFileRoute} from './project-route-access.ts';
import {requireDepartments,requireResource,requireKnowledgeDocument,requireCandidate} from './resource-authorization.ts';
import {AppError} from './provider.ts';
import {randomUUID} from 'node:crypto';
import {auditActor} from './audit-events.ts';
import {recordDeniedAudit} from './human-audit.ts';
import {assertCurrentRunAuthority,recordRunAuthorityDenial} from './run-current-authority.ts';
import {assertRestoreExecutionAdmitted} from './enterprise-restore-admission.ts';

export function authorizeRoute(policy:RoutePolicy|null,principal:Principal|null,path=policy?.path):boolean {
  if(!policy||!principal)return false;
  if(policy.access==='admin')return principal.kind==='local-owner'||(principal.kind==='human'&&principal.orgRole==='admin');
  if(policy.access==='member')return principal.kind==='local-owner'||principal.kind==='human'&&['admin','member'].includes(principal.orgRole);
  return principal.kind==='device'&&policy.path.startsWith('/api/local-devices/:id/')
    &&principal.deviceId===path?.split('/')[3];
}

export function apiAccess(identity:ReturnType<typeof createIdentityHttp>,config:IdentityConfig):RequestHandler {
  return async(req,res,next)=>{
    const path=req.baseUrl+req.path;
    const policy=routePolicy(req.method,path);
    if(!policy){res.sendStatus(404);return;}
    try{
      let principal:Principal|null;
      if(policy.access==='device'){
        const deviceId=path.split('/')[3];
        const device=await proveLocalDevice(deviceId,req.get('X-Local-Device-Key'));
        if(!device.enabled&&policy.path!=='/api/local-devices/:id/disable'){res.sendStatus(403);return;}
        principal={kind:'device',deviceId};
      }else principal=await identity.authenticate(req);
      if(!authorizeRoute(policy,principal,path)){
        res.status(principal?403:401).json({error:'Access denied'});return;
      }
      res.locals.principal=principal;
      // Quarantine permits authorized reads, explicit accounting and identity
      // maintenance. New mutation/effect routes default to denied.
      if(!['GET','HEAD'].includes(req.method)&&!policy.path.startsWith('/api/identity/')
        &&!['/api/knowledge/search','/api/costs/:id/query-provider','/api/costs/:id/reconcile','/api/backup/enterprise/activate','/api/backup/enterprise/export','/api/backup/enterprise/inspect'].includes(policy.path))await assertRestoreExecutionAdmitted(pool);
      if(policy.access==='member'&&principal){
        await currentRoutePrincipal(pool,principal);
        const parts=path.split('/'),id=parts[3];
        if(policy.path==='/api/department-workbench')await requireDepartments(pool,principal,[String(req.query.departmentId??'')],'viewer');
        else if(policy.path==='/api/projects'&&req.method==='POST')await requireDepartments(pool,principal,[...new Set<string>([req.body?.departmentId,...(Array.isArray(req.body?.collaboratingAgents)?req.body.collaboratingAgents.map((item:any)=>item?.departmentId):[])])],'operator');
        else if(policy.path.startsWith('/api/departments/:id'))await requireResource(pool,principal,{kind:'department',id},req.method==='GET'&&!policy.path.endsWith('/removed-employees')?'viewer':'manager');
        else if(policy.path.startsWith('/api/projects/:id'))await requireProjectRoute(pool,principal,id,req.method==='GET'?'viewer':'operator',policy.path.endsWith('/approve'));
        else if(policy.path==='/api/approvals/:id'){
          const approval=(await pool.query('SELECT run_id FROM tool_approvals WHERE id=$1',[id])).rows[0];
          if(!approval)throw new AppError(404,'资源不存在或不可访问','RESOURCE_NOT_FOUND');
          await requireRunRoute(pool,principal,approval.run_id,'operator',true);
        }
        else if(policy.path==='/api/work-files/from-run')await requireRunRoute(pool,principal,String(req.body?.runId??''),'operator');
        else if(policy.path.startsWith('/api/work-files/:id'))await requireFileRoute(pool,principal,id);
        else if(policy.path.startsWith('/api/knowledge/documents/:id'))await requireKnowledgeDocument(pool,principal,parts[4],req.method==='GET'?'viewer':'operator');
        else if(policy.path==='/api/knowledge/documents'&&req.method==='POST')await requireResource(pool,principal,{kind:'knowledgeSpace',id:String(req.body?.spaceId??'')},'operator');
        else if(policy.path==='/api/knowledge/search')await requireDepartments(pool,principal,[String(req.body?.departmentId??'')],'viewer');
        else if(policy.path==='/api/knowledge/reuse')await requireDepartments(pool,principal,[String(req.query.departmentId??'')],'viewer');
        else if(policy.path.startsWith('/api/knowledge/work-records/:id')){
          await requireRunRoute(pool,principal,parts[4],req.method==='GET'?'viewer':'operator');
          if(req.method==='POST')await requireResource(pool,principal,{kind:'knowledgeSpace',id:String(req.body?.spaceId??'')},'operator');
        }
        else if(policy.path==='/api/automation/knowledge-candidates'&&req.method==='POST')await requireRunRoute(pool,principal,String(req.body?.runId??''),'operator');
        else if(policy.path.startsWith('/api/automation/knowledge-candidates/:id'))await requireCandidate(pool,principal,parts[4],'operator');
        else if(policy.path.startsWith('/api/runs/:id')){
          await requireRunRoute(pool,principal,id,req.method==='GET'?'viewer':'operator',policy.path.endsWith('/retry'));
          if(policy.path==='/api/runs/:id/retry'&&req.method==='POST')await assertCurrentRunAuthority(pool,id,'retry',{lock:false});
        }
      }
      if(config.mode==='oidc'&&principal?.kind==='human'&&!['GET','HEAD'].includes(req.method)){
        identity.csrf(req,res,next);
      }else next();
    }catch(error){
      if(policy.path==='/api/runs/:id/retry')await recordRunAuthorityDenial(pool,error);
      // This read-only pre-cache rejection never enters the business transaction.
      // Keep its evidence even when a formerly successful request key exists.
      if(policy.path==='/api/approvals/:id'&&res.locals.principal&&/^[a-f0-9-]{36}$/i.test(path.split('/')[3]??'')&&['approved','denied'].includes(req.body?.decision)){
        const requestId=randomUUID(),denied=error instanceof AppError&&error.status>=400&&error.status<500;
        try{await recordDeniedAudit(pool,{eventId:randomUUID(),action:'tool.approval',actor:auditActor(res.locals.principal),
          correlation:{correlationId:requestId,requestId,approvalId:path.split('/')[3]},resource:{type:'tool_operation',id:path.split('/')[3],departmentIds:[]},
          outcome:denied?'denied':'failure',reasonCode:denied?'forbidden':'storage-unavailable',changes:{decision:req.body.decision,policyVersion:'human-approval-v1'}});}catch{/* Audit failure cannot turn a rejected request into a cache hit. */}
      }
      if(error instanceof AppError&&[401,403,404,409,422].includes(error.status)){res.status(error.status).json({code:error.code,message:error.message});return;}
      if((error as {status?:number}).status===403){res.status(403).json({error:'Access denied'});return;}
      res.status(503).json({error:'Identity service unavailable'});
    }
  };
}
