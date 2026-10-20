import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

// Ignore only the component's static stylesheet during the real React render.
registerHooks({load(url,context,next){return url.endsWith('/DepartmentWorkbench.css')?{format:'module',source:'',shortCircuit:true}:next(url,context);}});
const {DepartmentWorkbench}=await import('../apps/web/src/DepartmentWorkbench.tsx');
test('a new workspace with no departments renders its creation entry',()=>{
 const noop=()=>{};const html=renderToStaticMarkup(createElement(DepartmentWorkbench,{departments:[],selectedDepartmentId:null,onDepartment:noop,onNewDepartment:noop,onNewRequest:noop,onEditDepartment:noop,onProject:noop,onProjects:noop,onCosts:noop}));
 assert.match(html,/组建第一个部门/);assert.doesNotMatch(html,/部门工作台/);
});
