import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {RunAcceptanceChecks} from '../apps/web/src/RunAcceptanceChecks.tsx';
import {AcceptanceCheckEditor} from '../apps/web/src/AcceptanceCheckEditor.tsx';
test('UI distinguishes legacy, unverified and bound evidence, and escapes requirement content',()=>{
 const snapshot={projectId:'project',planVersion:1,tasks:[{id:'qa',subject:'QA',acceptanceCriteria:['<script>bad</script>'],acceptanceChecks:[{criterionIndex:0,command:'check'}]}]};
 const render=(evidence?:any)=>renderToStaticMarkup(createElement(RunAcceptanceChecks,{runId:'run',snapshot,evidence}));
 assert.match(render(),/未验证/);assert.ok(!render().includes('<script>'));
 const evidence={version:1 as const,runId:'run',projectId:'project',planVersion:1,sourceRunId:null,status:'none' as const,receipts:[],tests:[],issues:[],acceptance:{runId:'run',planVersion:1,rows:[{taskId:'qa',criterionIndex:0,criterion:snapshot.tasks[0].acceptanceCriteria[0],command:'check',status:'passed',reason:'',sourceRunId:'run',attemptId:'a',workspaceRevision:'revision'}]}};
 assert.match(render(evidence),/命令证据通过/);assert.ok(!render({...evidence,runId:'other'}).includes('命令证据通过'));
 const legacy=structuredClone(snapshot);delete (legacy.tasks[0] as any).acceptanceChecks;
 assert.match(renderToStaticMarkup(createElement(RunAcceptanceChecks,{runId:'run',snapshot:legacy,evidence})),/未定义逐项/);
});
test('editor exposes approved commands, exact output and useful test count',()=>{
 const task={id:'qa',subject:'QA',objective:'verify',assigneeId:'qa',dependencies:[],acceptanceCriteria:['可启动'],verify:['node --test cli.test.mjs'],estimatedInputTokens:1,estimatedOutputTokens:1,acceptanceChecks:[{criterionIndex:0,command:'node --test cli.test.mjs',minimumTests:1}]};
 const html=renderToStaticMarkup(createElement(AcceptanceCheckEditor,{task,update:()=>{}}));
 assert.match(html,/最低通过测试数/);assert.match(html,/完整输出预期/);assert.match(html,/node --test cli.test.mjs/);
});

test('editor never preselects a command for every criterion and excludes syntax proof',()=>{
 const task:any={id:'dev',acceptanceCriteria:['功能 A','功能 B'],verify:['node --check app.mjs','node --test app.test.mjs']};
 let patch:any;
 const tree=AcceptanceCheckEditor({task,update:p=>patch=p});
 const walk=(node:any):any[]=>!node||typeof node!=='object'?[]:[node,...[node.props?.children].flat(Infinity).flatMap(walk)];
 walk(tree).find(n=>n.type==='input'&&n.props.type==='checkbox').props.onChange({target:{checked:true}});
 assert.deepEqual(patch.acceptanceChecks.map((c:any)=>c.command),['','']);
 const html=renderToStaticMarkup(createElement(AcceptanceCheckEditor,{task:{...task,...patch},update:()=>{}}));
 assert.ok(!html.includes('value="node --check'));assert.ok(html.includes('value="node --test'));
});
test('historical passed syntax evidence is labelled as syntax, not functional acceptance',()=>{
 const task={id:'dev',acceptanceCriteria:['功能正确'],acceptanceChecks:[{criterionIndex:0,command:'node --check app.mjs'}]};
 const snapshot={projectId:'p',planVersion:1,tasks:[task]};
 const evidence:any={runId:'r',projectId:'p',planVersion:1,acceptance:{runId:'r',planVersion:1,rows:[{taskId:'dev',criterionIndex:0,criterion:'功能正确',command:'node --check app.mjs',status:'passed'}]}};
 const html=renderToStaticMarkup(createElement(RunAcceptanceChecks,{runId:'r',snapshot,evidence}));
 assert.match(html,/语法检查通过，不代表功能验收/);assert.ok(!html.includes('命令证据通过'));
});
test('historical delivery headline does not promote syntax receipts to functional success',()=>{
 const snapshot={projectId:'p',planVersion:1,tasks:[{id:'qa',acceptanceCriteria:['功能'],acceptanceChecks:[{criterionIndex:0,command:'node --check app.mjs'}]}],deliveryCriteria:[{id:'c',description:'功能可用',checkTaskId:'qa',checkCriteriaIndexes:[0]}]};
 const evidence:any={runId:'r',projectId:'p',planVersion:1,acceptance:{runId:'r',planVersion:1,rows:[],deliveryCriteria:[{criterionId:'c',description:'功能可用',status:'passed',reason:'Checks passed',evidenceRefs:[{taskId:'qa',criterionIndex:0,kind:'command',sourceRunId:'r',attemptId:'a'}]}]}};
 const html=renderToStaticMarkup(createElement(RunAcceptanceChecks,{runId:'r',snapshot,evidence}));
 assert.match(html,/仅有语法检查，功能验收未验证/);assert.ok(!html.includes('交付检查通过'));
});
