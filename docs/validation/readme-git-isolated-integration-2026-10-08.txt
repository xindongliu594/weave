Simulated integration: PGlite + pgvector, a fresh database for each test file and one product DB connection.
Models are test doubles; native device scenarios use real temporary workspaces. Docker and independent backend locks are excluded.
✔ demand discussion records actual usage without estimating or reserving an execution budget (8550.9598ms)
✔ usage-only accounting cannot be applied to execution or project identities (31.4331ms)
✔ missing conversation usage stays unknown without claiming zero supplier charge (101.3879ms)
✔ parallel direct calls reserve globally before fetch and departmental caps cover planning and execution admission (483.9975ms)
✔ runtime requests share the run reservation and uncertain costs survive completion and block retry (217.6749ms)
✔ missing usage and network failures retain a lease until explicit reconciliation using pinned prices (343.7906ms)
✔ known receipts are recorded despite malformed output or excessive usage; late receipts correct a manual entry once (178.0646ms)
✔ 403 response identifiers remain public after a failed bill query without releasing fees or replaying the model (231.5549ms)
✔ cost response selects only safe response fields and preserves absent IDs without exposing reservation context (126.5017ms)
✔ backup refuses live calls and restores unresolved reservations without inventing a zero charge (365.8606ms)
ℹ tests 10
ℹ suites 0
ℹ pass 10
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 12431.4902
✔ clarification replies retain global billed usage and do not create departments, previews or runs (2200.2909ms)
✔ documented GPT-4.1 JSON mode preserves usage tracking and makes no repair call or preview on invalid output (111.5709ms)
✔ second round uses conversation context but only user messages become the saved requirement; preview saves idempotently (153.3095ms)
✔ legacy per-reply hints and exhausted daily budgets do not stop discussion or charge new execution projects (113.4241ms)
✔ only explicitly granted filesystem tools produce a valid implementation and independent review draft (106.6614ms)
✔ missing/unavailable models, malformed histories and insufficient request budget fail before provider dispatch (122.4452ms)
✔ tool, hidden identity, external scopes and out-of-whitelist model proposals never overwrite existing drafts (431.1305ms)
✔ the planner is separate from authorized Luna/Sol employee models while unavailable and ungranted IDs remain excluded (192.6242ms)
✔ invalid JSON, task DAG, assigned file tools and automatic rework retain replies and billed usage without publishing drafts (168.5473ms)
✔ revision context includes stored employee IDs and task DAG without inheriting old permissions (160.4727ms)
✔ natural consultation, fenced replies and explicit null candidates continue without a draft or extra calls (232.2056ms)
✔ partial candidates preserve useful replies, never render JSON fragments, and remain idempotent (506.5741ms)
✔ long conversations retain all user requirements but send bounded recent context and earlier user excerpts (86.8667ms)
✔ oversized prior previews use a marked bounded reference without sending truncated JSON to the model (53.9667ms)
✔ organization planning headers timeout uses 180 seconds, preserves unknown cost and replays only the failed HTTP receipt (284.3589ms)
✔ organization planning body timeout uses 180 seconds, preserves unknown cost and replays only the failed HTTP receipt (284.4585ms)
ℹ tests 16
ℹ suites 0
ℹ pass 16
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 5756.2767
✔ confirming a revised proposal updates the same team and draft project, records versions, and never executes (2280.1985ms)
✔ execution state, archived teams and mismatched project ownership refuse an update without partial writes (166.5896ms)
✔ all adopted planning charges count toward the updated budget and transfer only after successful confirmation (131.305ms)
✔ revisions still require preview identity and explicit tool permissions (65.9775ms)
✔ pending and uncertain project charges block a revision before any budget or team change (131.3802ms)
✔ a team participating in another active project cannot be changed through a saved conversation (150.5949ms)
✔ employee prompt revisions advance role versions while replay and unchanged roles preserve them (143.4287ms)
ℹ tests 7
ℹ suites 0
ℹ pass 7
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3559.4894
✔ independent new conversations with identical first prompts have distinct UUIDs and request keys (1390.3968ms)
✔ stored UUID survives reload, consultation, model settings changes and further turns (3.8839ms)
✔ legacy stored draft gains metadata once while a persisted pending body and idempotency key remain byte-identical (0.6007ms)
✔ new pending request UUID is authoritative on reload without altering any stored request fields (0.5073ms)
✔ cancelled reset is immutable; confirmed reset archives original UUID/body before renewing the conversation (2.4827ms)
✔ failed history persistence cannot replace the active conversation or mutate its pending request (0.8964ms)
✔ actual API uses UUID attribution on multiple turns; duplicate same-key retrieval neither re-dispatches nor adds cost (195.3137ms)
✔ two actual conversations with the same prompt remain separately attributed; UUID does not enter model messages (110.8949ms)
✔ legacy pending same-key request keeps its exact input; invalid UUIDs are rejected before reserve and fetch (135.1885ms)
✔ Go transport hashes each conversation UUID stably across retrieval, reload and further turns without external traffic (152.2912ms)
ℹ tests 10
ℹ suites 0
ℹ pass 10
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3503.4773
✖ D1 API and actual DSH execute native device files and an approved command, preserving verified handoff and accounting (42202.5234ms)
✖ D1 lost poll response recovers an unstarted claim and executes it exactly once (40015.2832ms)
✖ D1 revoked device grants reject dispatch after approval and do not become unknown mutations (35012.7705ms)
✖ D1 cancels an in-flight native command and reconnects by reporting its receipt without replay (40209.4157ms)
✖ approved API flow waits for command approval, hands off verified files and settles usage (30004.6898ms)
✖ employee summaries are billed to the active task and preserve approved contracts through handoff (30013.2522ms)
✖ approved API rework repairs, independently re-reviews and bills the original task buckets (11869.3249ms)
✖ API rework stops at its call allowance and full retry cannot reset the task counter (12059.048ms)
✖ API rework escalates exhausted rounds, forbidden files and explicit rejection (11904.8412ms)
✖ missing output and forged verification cannot dispatch the dependent reviewer (21447.1651ms)
Integration file tests/product-flow.test.ts exceeded 300 seconds
