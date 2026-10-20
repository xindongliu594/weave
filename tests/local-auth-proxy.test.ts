import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {mergeConfig} from 'vite';

test('local and demo launchers bind identity, business and health to the selected API',()=>{
 for(const file of ['scripts/local.mjs','scripts/demo.mjs']){
  const ast=ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  let config:ts.ObjectLiteralExpression|undefined;
  const visit=(node:ts.Node)=>{if(ts.isCallExpression(node)&&node.expression.getText(ast)==='createServer'&&ts.isObjectLiteralExpression(node.arguments[0]))config=node.arguments[0];ts.forEachChild(node,visit);};visit(ast);assert.ok(config,file);
  const property=(node:ts.ObjectLiteralExpression,key:string)=>{const member=node.properties.find(item=>ts.isPropertyAssignment(item)&&item.name.getText(ast).replace(/['"]/g,'')===key);assert.ok(member&&ts.isPropertyAssignment(member),file+':'+key);return member.initializer;};
  const server=property(config,'server');assert.ok(ts.isObjectLiteralExpression(server));const proxy=property(server,'proxy');assert.ok(ts.isObjectLiteralExpression(proxy));
  const selected=54321,overrides:Record<string,string>={};
  for(const key of ['/api','/auth','/healthz']){const target=property(proxy,key);assert.ok(ts.isTemplateExpression(target));assert.equal(target.templateSpans.length,1);assert.equal(target.templateSpans[0].expression.getText(ast),'ready.apiPort');overrides[key]=target.head.text+selected+target.templateSpans[0].literal.text;}
  const merged=mergeConfig({server:{proxy:{'/auth':'http://127.0.0.1:4311'}}},{server:{proxy:overrides}});
  for(const key of ['/api','/auth','/healthz'])assert.equal(merged.server.proxy[key],'http://127.0.0.1:'+selected);
 }
});
