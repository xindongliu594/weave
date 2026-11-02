# Member Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement task-by-task. Shared main only; do not branch, commit, reset, stash or edit another worker's files.

**Goal:** Active human members can read their authorized departments, projects and run summaries without mounting the administrator App.

This is a read-only P0 slice, not a complete member execution workspace. Artifact/detail/download and write actions are excluded.

**Architecture:** Keep `identityAuthorized` and common `api()` administrator semantics. Add a narrow member read session check using existing generation/abort lifecycle; use an allowlisted GET transport and independent React workspace. Backend current-authority checks remain authoritative.

**Tech Stack:** Existing React 19.1.1, TypeScript, node:test/tsx; existing openid-client 6.8.8 remains untouched.

**Spec:** Research and proposed design: `docs/research/2026-10-29-member-workspace.md`; parent scope approval required before product edits.

## Permission matrix

| Identity | Administrator children | Member workspace | Requests |
| --- | --- | --- | --- |
| local-owner / active admin | Existing behavior | No | Existing transport |
| active authenticated member | No | Yes | GET departments/projects/runs only |
| auditor | No | No | No business requests |
| pending/disabled/signed-out/unavailable | No | No | No business requests |

Department viewer/operator/manager distinctions are evaluated by backend, not inferred by frontend. No create/approve/retry/cancel/manage/budget UI. GET run detail is admin-only and never requested.

## Files

- Modify `apps/web/src/IdentityGate.tsx` to mount member workspace only for verified member.
- Modify `apps/web/src/identity-session.ts` to expose a narrow member read check; do not broaden identityAuthorized/principalStorage/common api.
- Create `apps/web/src/MemberWorkspace.tsx`, `MemberWorkspace-data.ts`, `tests/member-workspace.test.ts` and `tests/member-workspace-ui.test.ts`.
- Parent also approved edits to `tests/identity-gate.test.ts`, the related `IdentityManagement.tsx` entry copy and `tests/identity-management-ui.test.ts`. App.tsx/styles.css/backend/package files remain untouched.
- Evidence `docs/validation/member-workspace-2026-10-29.md`; logs `.private/p0-member-workspace-20261029`.

## Tasks

- [x] Parent confirms implementation scope.
- [x] RED: member requests denied before member read API exists; pending/auditor remain denied; SSR gate member mounts dedicated workspace and excludes admin subtree.
- [x] Implement minimal transport and list page. Same-origin/no-store, identity abort + timeout, generation check after response body; 401 invalidates, 403/404 clear displayed data, no automatic retry. Refresh clears old rows before requesting. Page offsets for project/run lists remain server-filtered, latest response wins.
- [x] GREEN: dedicated tests plus identity-session/reset/gate regression pass 27/27; scoped isolated resource HTTP tests pass 4/4. Full HTTP file stopped during a later lock test and is not marked passing. Root executes full typecheck/build.
- [x] Record commands, exit codes/counts, unverified real OIDC/browser/model/deployment explicitly in `docs/validation/member-workspace-2026-10-29.md`.

## Independent review P2 correction

- [x] Reproduce same-identity session publication starving pending reads and retrying denied reads using controlled promises and session publish callbacks (2 failing behavior assertions).
- [x] Separate automatic refresh from explicit user retry: automatic skips loading/error; generation/reset retains identity-change cleanup.
- [x] Targeted P2 GREEN 2/2 and related frontend regression 29/29 pass; no HTTP rerun or shared backend changes. Evidence in the original validation report. Root arranges independent re-review and unified typecheck/build.
