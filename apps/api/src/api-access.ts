import type {RequestHandler} from 'express';
import type {Principal,IdentityConfig} from './identity-types.ts';
import type {createIdentityHttp} from './identity-http.ts';
import {routePolicy,type RoutePolicy} from './api-route-policies.ts';
import {proveLocalDevice} from './local-execution.ts';

export function authorizeRoute(policy:RoutePolicy|null,principal:Principal|null,path=policy?.path):boolean {
  if(!policy||!principal)return false;
  if(policy.access==='admin')return principal.kind==='local-owner'||(principal.kind==='human'&&principal.orgRole==='admin');
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
      if(config.mode==='oidc'&&principal?.kind==='human'&&!['GET','HEAD'].includes(req.method)){
        identity.csrf(req,res,next);
      }else next();
    }catch(error){
      if((error as {status?:number}).status===403){res.status(403).json({error:'Access denied'});return;}
      res.status(503).json({error:'Identity service unavailable'});
    }
  };
}
