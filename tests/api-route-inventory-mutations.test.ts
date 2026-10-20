import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {assertRouteInventory} from '../apps/api/src/api-route-policies.ts';

test('startup inventory rejects changed mounts and unsupported Express registrations',()=>{
  const original=fs.readFileSync;
  const mutations=[
    ['chained route','app.ts',(source:string)=>source+"\napp.route('/api/unclassified-review').get((_req,res)=>res.json({ok:true}));"],
    ['all methods','app.ts',(source:string)=>source+"\napp.all('/api/unclassified-review',(_req,res)=>res.json({ok:true}));"],
    ['router instance','app.ts',(source:string)=>source+"\napp.use('/api/unclassified-review', reviewRouter);"],
    ['outside api','app.ts',(source:string)=>source+"\napp.get('/unclassified-review',(_req,res)=>res.json({ok:true}));"],
    ['mount prefix','app.ts',(source:string)=>source.replace("app.use('/api',localDeviceRouter(traceRoot));","app.use('/unexpected',localDeviceRouter(traceRoot));")],
    ['head registration','app.ts',(source:string)=>source+"\napp.head('/api/unclassified-review',(_req,res)=>res.end());"],
    ['options registration','app.ts',(source:string)=>source+"\napp.options('/api/unclassified-review',(_req,res)=>res.end());"],
    ['other HTTP registration','app.ts',(source:string)=>source+"\napp.trace('/api/unclassified-review',(_req,res)=>res.end());"],
    ['unsupported registration name','app.ts',(source:string)=>source+"\napp.custom('/api/unclassified-review',(_req,res)=>res.end());"],
    ['route file middleware','knowledge.ts',(source:string)=>source+"\nrouter.use('/unclassified-review',foreignRouter);"],
    ['second middleware handler','app.ts',(source:string)=>source.replace("app.use(express.json({ limit: '2mb' }));","app.use(express.json({ limit: '2mb' }), foreignRouter);")],
    ['middleware array','app.ts',(source:string)=>source.replace("app.use(express.json({ limit: '2mb' }));","app.use([express.json({ limit: '2mb' }), foreignRouter]);")],
  ] as const;
  try{
    for(const [label,target,mutate] of mutations){
      fs.readFileSync=((path:any,...args:any[])=>{
        const source=(original as any)(path,...args);
        if(String(path).replaceAll('\\','/').endsWith('/'+target)&&typeof source==='string'){
          const changed=mutate(source);assert.notEqual(changed,source,label);return changed;
        }
        return source;
      }) as typeof fs.readFileSync;
      syncBuiltinESMExports();
      assert.throws(()=>assertRouteInventory(),label);
    }
  }finally{fs.readFileSync=original;syncBuiltinESMExports();}
});
