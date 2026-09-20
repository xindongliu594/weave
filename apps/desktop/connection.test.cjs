const { test }=require('node:test'); const assert=require('node:assert/strict');
const {normalizeServer,isWorkspaceURL}=require('./connection.cjs');
test('desktop connections require secure remote origins and stay inside configured workspace',()=>{
  assert.equal(normalizeServer('https://47.88.76.167/agent-department'),'https://47.88.76.167/agent-department/');
  for(const value of ['http://example.com','javascript:alert(1)','https://user:password@example.com','https://example.com/?secret=x']) assert.throws(()=>normalizeServer(value));
  const base='https://47.88.76.167/agent-department/';
  assert.ok(isWorkspaceURL(base+'#run',base));
  assert.ok(!isWorkspaceURL('https://47.88.76.167/admin/',base));
  assert.ok(!isWorkspaceURL('https://evil.example/agent-department/',base));
});
