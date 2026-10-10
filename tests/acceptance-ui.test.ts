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
