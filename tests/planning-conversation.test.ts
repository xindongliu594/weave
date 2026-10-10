import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {planningConversation} from '../apps/api/src/planning-conversation.ts';

test('bounded project dialogue discloses earlier omitted requirements and counts pending replies outside the window',async()=>{
 const db=await PGlite.create();
 try{
  await db.query('CREATE TABLE manager_messages(id text,project_id text,project_version int,content text,reply text,status text,created_at timestamptz)');
  for(let i=0;i<13;i++)await db.query('INSERT INTO manager_messages VALUES($1,$2,1,$3,$4,$5,$6)',[String(i),'project',i===0?'最早的必选需求':'补充'+i,'已理解',i===0?'waiting':'replied',new Date(2026,0,1,0,i).toISOString()]);
  const result=await planningConversation(db as any,'project',1);
  assert.equal(result.count,13);
  assert.equal(result.omitted,1);
  assert.equal(result.pendingCount,1);
  assert.equal(result.messages.length,12);
 }finally{await db.close();}
});
