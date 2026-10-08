Simulated integration: PGlite + pgvector, a fresh database for each test file and one product DB connection.
Models are test doubles; native device scenarios use real temporary workspaces. Docker and independent backend locks are excluded.
✔ D1 API and actual DSH execute native device files and an approved command, preserving verified handoff and accounting (12300.5355ms)
✔ D1 lost poll response recovers an unstarted claim and executes it exactly once (9314.9823ms)
✔ D1 revoked device grants reject dispatch after approval and do not become unknown mutations (2550.27ms)
✔ D1 cancels an in-flight native command and reconnects by reporting its receipt without replay (5820.9424ms)
✔ approved API flow waits for command approval, hands off verified files and settles usage (3845.7708ms)
✖ employee summaries are billed to the active task and preserve approved contracts through handoff (4370.3465ms)
✔ approved API rework repairs, independently re-reviews and bills the original task buckets (7302.367ms)
✔ API rework stops at its call allowance and full retry cannot reset the task counter (4492.1876ms)
✔ API rework escalates exhausted rounds, forbidden files and explicit rejection (16709.8531ms)
✔ missing output and forged verification cannot dispatch the dependent reviewer (3576.6401ms)
✔ a modified accepted input is rejected before the reviewer makes a model request (2356.4491ms)
✔ cancellation while approval is pending cancels the receipt and never runs the command (1639.3343ms)
✔ C3 monitors actual employee waits and stops repeated actions/errors before more paid calls (4912.1114ms)
✔ C3 retries a transient read within the same tool call, without extra model charges (4312.3865ms)
✔ C3 never replays an uncertain write; explicit reconciliation is recorded before a bounded retry (5298.3802ms)
✔ checkpoint resume returns the active child without duplicate rows or model dispatch and keeps the new-parent activity guard (6513.495ms)
✔ checkpoint recovery preserves the DAG, unfinished files and history across two interruptions (10202.5595ms)
✔ C3 restores an independently passed rework pair and runs only its remaining consumer (10882.7313ms)
ℹ tests 18
ℹ suites 0
ℹ pass 17
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 117167.7555

✖ failing tests:

test at tests\product-flow.test.ts:1:28019
✖ employee summaries are billed to the active task and preserve approved contracts through handoff (4370.3465ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

  16384 !== 8192

      at TestContext.<anonymous> (C:\Users\JJ\.codex\worktrees\f57c\agent_department\tests\product-flow.test.ts:335:10)
      at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
      at async Test.run (node:internal/test_runner/test:1389:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:960:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 16384,
    expected: 8192,
    operator: 'strictEqual',
    diff: 'simple'
  }
