import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildNativeToolBundle} from '../scripts/plugins/build-native-tool-bundle.mjs';

const fixture=()=>{const root=mkdtempSync(join(tmpdir(),'native-boundary-')),pkg=join(root,'plugin'),out=join(root,'out');mkdirSync(pkg);writeFileSync(join(root,'lock.json'),'{}');writeFileSync(join(root,'definition.json'),JSON.stringify({namespace:'fixture',package:'fixture-plugin',version:'1.0.0',source:{kind:'company',reference:'test'},config:{},files:{tool:{read:[],write:[]}}}));return {root,pkg,out,definition:join(root,'definition.json'),lock:join(root,'lock.json')};};
test('builder rejects a package main outside installed package before reading it',async()=>{
 const f=fixture();try{writeFileSync(join(f.root,'secret.mjs'),'throw Error("outside executed")');writeFileSync(join(f.pkg,'package.json'),JSON.stringify({name:'fixture-plugin',version:'1.0.0',main:'../secret.mjs'}));await assert.rejects(buildNativeToolBundle(f.definition,f.pkg,f.lock,f.out),/NATIVE_PACKAGE_ENTRY_DENIED/);}finally{rmSync(f.root,{recursive:true,force:true});}
});
test('builder rejects a relative import escaping the installed package before loading it',async()=>{
 const f=fixture();try{writeFileSync(join(f.root,'secret.mjs'),'export default "outside"');writeFileSync(join(f.pkg,'package.json'),JSON.stringify({name:'fixture-plugin',version:'1.0.0',main:'index.mjs'}));writeFileSync(join(f.pkg,'index.mjs'),"import value from '../secret.mjs'; export default value;");await assert.rejects(buildNativeToolBundle(f.definition,f.pkg,f.lock,f.out),/NATIVE_PACKAGE_SOURCE_DENIED/);}finally{rmSync(f.root,{recursive:true,force:true});}
});
test('builder resolves an ancestor-shadowed bare dependency from fixed runtime modules',async()=>{
 const root=mkdtempSync(join(dirname(fileURLToPath(import.meta.url)),'.native-shadow-')),pkg=join(root,'plugin'),out=join(root,'out');
 try{mkdirSync(pkg);writeFileSync(join(root,'lock.json'),'{}');writeFileSync(join(root,'definition.json'),JSON.stringify({namespace:'fixture',package:'fixture-plugin',version:'1.0.0',source:{kind:'company',reference:'test'},config:{},files:{tool:{read:[],write:[]}}}));writeFileSync(join(pkg,'package.json'),JSON.stringify({name:'fixture-plugin',version:'1.0.0',type:'module',main:'index.mjs'}));writeFileSync(join(pkg,'index.mjs'),"import iconv from 'iconv-lite'; export default function plugin(){ return iconv.encodingExists('utf8'); }");
  await assert.rejects(buildNativeToolBundle(join(root,'definition.json'),pkg,join(root,'lock.json'),out),/NATIVE_SCHEMA_PROBE_FAILED/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
