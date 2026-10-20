# Task 1 independent spec and quality review

Decision: **PASS for the private native primitive only. No reproducible P0–P2 finding within the supported contract.**

Reviewed against baseline `3eaac81`, the public plan's Global Rules and Task 1, the private task brief, controller rulings in `progress.md`, and the implementer's report. Read the exact four new source/declaration/test/helper files, the runtime package manifest diff, installed native wrapper/platform locking source, and saved RED/final/regression/build/declaration/Linux evidence. No tests, network/JJ access, deployment, model calls, Git mutations, source edits, or subagents were performed by this reviewer. This review file is the only write.

## Spec and implementation assessment

- Factory inputs reject noncanonical, linked, non-directory, equal/nested roots; namespace remains tied to the logical trace path while fixed parent/lock/namespace identities are rechecked. Files use exclusive creation or nontruncating existing opens, with regular-file, nlink, path/FD dev/ino checks. Root-exclusive deliberately omits the replaceable trace leaf identity. Release closes owned FDs even after identity validation fails.
- Per-acquisition FD ownership, private WeakMap branding, exact factory ownership, mode/run checks, frozen handles, and explicit live state match the guard contract. Neither post-acquisition abort nor an elapsed acquisition timeout revokes a completed guard.
- Acquisition order is root gate then sorted run IDs. A shared monotonic deadline governs all acquisition attempts; timeout/abort/failure close partial records in reverse order. Native source uses Linux `F_OFD_SETLK` and Windows `LockFileEx`, supporting independent open-handle lifetimes rather than process-wide POSIX record-lock ownership.
- Journal entry requires an authorized writer/maintenance guard, obtains its own exclusive FD lock, preserves callback result/exception semantics, and cleans up in `finally`. The corrected depth counter keeps outer guard release blocked after a nested different-run journal returns. Same-journal reentry, declared async callbacks, and returned thenables reject. As explicitly scoped, callback code is trusted synchronous internal code; detecting a returned thenable cannot undo effects already executed.
- Runtime package diff adds exact direct `fs-native-extensions@1.5.1` and six new lockfile package records, with no changes to existing package records. Search found production imports absent; imports are confined to the new test and child helper. Tasks 2–4 remain future integration work.

## Evidence assessment

Read actual assertions rather than relying only on test names/counts. They exercise cross-process writer coexistence/source exclusion, root exclusion, holder exit, timeout/abort rollback, whole-acquisition timeout, journal return/throw/reentry/depth behavior, no callback on contention timeout, eventual short-contention success, exact 60-entry cross-process journal sequence, path swaps, links, file type and preserved existing contents.

- Saved initial RED documents missing factory failure. Saved edge RED documents sparse run input, nested journal early release, and invalid-root failures before their fixes.
- Final ordinary Windows log: 20 tests, 17 pass, 0 fail, 3 explicit fixture skips. Namespace/lockRoot renames while locked and file symlink creation were unavailable; those skips are not evidence of product rejection on Windows.
- Controller's isolated Linux/JJ `final-test.tap`: 20 tests, 20 pass, 0 fail, 0 skip, exit 0 in saved metadata; the three otherwise unavailable fixtures execute there. This reviewer inspected supplied raw output/metadata, not the remote machine.
- Existing trace cursor/journal regressions: 17 pass, 0 fail, 0 skip. Root build and separate strict declaration check: exit 0. Build retains the reported large-chunk warning.
- Independently recomputed all four final source hashes and the Linux TAP hash; each matches the saved report/metadata. Linux TAP SHA256: `e8dccb39565550f51ee0356fbc679665541fe6ddb23532be1652ecfa2b7666ae`.

## Reviewed final SHA256

| File | SHA256 |
| --- | --- |
| `services/agent-runtime/archive-write-fence.mjs` | `1f0e293feb055d8bfc4def8c53359070eb0b57df5b6d56d4e4f96cedeaed83fd` |
| `services/agent-runtime/archive-write-fence.d.mts` | `d67cf194b1a70590224ff15751b78758c79a71f57f694b60fab05a1a6440a788` |
| `services/agent-runtime/archive-write-fence.test.mjs` | `30cecd4f033ed061d56e2a6cf02d376a646640028f19d2f095fd696567b16613` |
| `services/agent-runtime/test-helpers/archive-write-fence-child.mjs` | `98f2dda69b1de8b00f9719a352f6d0349ab0e9582532bda35173f2888fb07659` |
| `services/agent-runtime/package.json` | `0fbc7299bcc0d9faf2e4a033eacad11042d7dfa7a7c33036ad33f9920a1d3948` |
| `services/agent-runtime/package-lock.json` | `a82ccb7ab88ecbb05f672d6d60b4b8bcc668b8e073491c209d98b87625576a3c` |

Approval does not establish production writer coverage, producer drain, SQL ordering, restore approval, deployment safety, or a universal mapping across separately configured lock roots. Same-OS-user adversarial path replacement, network filesystems, nonparticipants and mixed old/new processes remain outside this primitive's supported guarantee. No broad refactoring or added integration requirement is requested for Task 1.
