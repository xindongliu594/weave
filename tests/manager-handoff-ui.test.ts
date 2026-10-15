import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {RunHandoffReports} from '../apps/web/src/RunHandoffReports.tsx';
import {TaskContractSummary} from '../apps/web/src/TaskContracts.tsx';

const task:any={id:'qa',subject:'独立核验',handoff:{sections:[{key:'coverage',requirement:'说明覆盖范围'}]}};
const record={taskId:'qa',attemptId:'a',runId:'source-run',workspaceRevision:'version-sha',outputs:[{path:'result.md',sha256:'file-sha'}],employeeReport:{version:1,summary:'员工提交结论',sections:{coverage:'<script>覆盖说明</script>'},risks:['未覆盖外部服务']}};
test('web exposes manager requirements and sealed reports with source/version, without treating them as live acceptance',()=>{
  const summary=renderToStaticMarkup(createElement(TaskContractSummary,{task}));
  assert.match(summary,/说明覆盖范围/);
  const html=renderToStaticMarkup(createElement(RunHandoffReports,{snapshot:{tasks:[task],handoffCheckpoints:[record]},events:[{type:'handoff/accepted',data:record}]}));
  for(const text of ['source-run','version-sha','file-sha','未覆盖外部服务','历史交接不代表当前项目已通过','说明覆盖范围'])assert.ok(html.includes(text));
  assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));
  assert.equal(html.split('员工提交结论').length-1,1,'restored record and event are not rendered twice');
  assert.equal(renderToStaticMarkup(createElement(RunHandoffReports,{snapshot:{},events:[{type:'handoff/blocked',data:record}]})),'');
});
