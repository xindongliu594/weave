import test from 'node:test';
import assert from 'node:assert/strict';
import {projectAssignmentReports,projectClaimReport} from './assignment-reports.mjs';
const context={task:{handoff:{sections:[{key:'coverage',requirement:'coverage'}]},dependencies:['qa']},runtimeTaskId:'t3',attemptId:'attempt',runEvidence:{completedAncestors:[{taskId:'qa',employeeReport:{summary:'known'}}]}};
const text='AgentTeams automatic task assignment from the shared task list.\nCompleted dependency results:\nHOST_REPORT\n\nTask: t3 — accept\nAttempt id: attempt\n';
const messages=[{role:'user',source:{kind:'user'},content:[{type:'text',text}]}];
test('projection removes only the exact bound native segment; identity, raw user data and legacy behavior stay intact',()=>{
  const before=structuredClone(messages);
  const projected=projectAssignmentReports(messages,context,'HOST_REPORT');
  assert.ok(!JSON.stringify(projected).includes('HOST_REPORT'));assert.deepEqual(messages,before);
  for(const changed of [{...context,attemptId:'other'},{...context,runtimeTaskId:'other'},{...context,task:{dependencies:['qa']}},{...context,runEvidence:{completedAncestors:[]}}])
    assert.deepEqual(projectAssignmentReports(messages,changed,'HOST_REPORT'),messages);
  assert.deepEqual(projectAssignmentReports(messages,context,'DIFFERENT_BODY'),messages);
  const user=[{role:'user',content:[{type:'text',text:'Please read HOST_REPORT'}]}];
  assert.deepEqual(projectAssignmentReports(user,context,'HOST_REPORT'),user);
  const claim={task_id:'t3',attempt_id:'attempt',task_details:'Contract\nDependency results:\nHOST_REPORT'};
  assert.ok(!projectClaimReport(claim,context,'HOST_REPORT').task_details.includes('HOST_REPORT'));
  assert.deepEqual(projectClaimReport({...claim,attempt_id:'other'},context,'HOST_REPORT'),{...claim,attempt_id:'other'});
  assert.deepEqual(projectClaimReport(claim,context,'DIFFERENT_BODY'),claim);
});
