# Isolated native lock pilot review

**One P2 evidence finding; Task 1 codec PASS is unchanged.**

## [P2] Observe descriptor-close release before the owner process exits

`scripts/validation/native-file-lock-pilot.cjs:135–140` waits for `owner.exit` before checking that the contender can acquire the lock for every command, including `close`. The worker's `close` branch closes its descriptor and immediately schedules `process.exit(0)` (`:55–59`). Consequently the Windows and JJ result named `exclusive blocks until owner close` cannot establish that closing the descriptor releases the lock while its owning process remains alive. An implementation that retained this lock until process termination would pass the same check. This is a limitation in the claimed evidence, not an observed failure of the library.

Required fix: keep the worker alive after closing, acknowledge `closed`, have the parent acquire/release the lock while the worker is still alive, then explicitly exit the worker. Regenerate both platform reports after changing the script. Alternatively narrow the result name/documented claim to close followed by process exit and explicitly mark close-only release unverified.

## Checks supporting the remaining evidence

- `child_process.fork(__filename, ...)` creates distinct OS worker processes with independent descriptor opens. IPC ready/start synchronization precedes the two-process counter loop. Each worker performs 30 read/sleep/write increments inside a successful native lock, and the parent checks both zero exits and the final counter of 60.
- Contention is asserted while owner processes have reported ready. Shared-owner exclusion is checked with both owners present and again after one exits. Normal exit leaves the descriptor open for OS cleanup; kill invokes `SIGKILL` and awaits process closure before reacquisition. Same-process unlock/reacquire is separately exercised.
- Test files are created under a randomized directory within the isolated dependency root. The reviewed script has no product/database/model/network invocation. The stated limits correctly exclude product writer coverage, lifecycle, SQL, network filesystems and recovery.
- Both reports show `replaced: true` and `newFileLocked: true` for the pathname check. Its `passed` means measurement completed; the explicit interpretation requires preserving the lock inode and covering all writers. It does not claim pathname protection.
- The isolated package manifest pins `fs-native-extensions` to 1.5.1; the actual lockfile entry has the script's expected SHA512 integrity. Current hashes match both JSON reports exactly:

```text
96760ff6a3e4efd9d897280098b8b19898494fd8c173176923344549eb93fb74  scripts/validation/native-file-lock-pilot.cjs
512ce43748bb2c5f56e04c00be31f30e8e90cc9283e1516bb9c47f90c386e54c  .superpowers/sdd/2026-10-21-task-recovery-source/lock-pilot/package-lock.json
```

Review limits: static source, manifest, lockfile and saved JSON inspection only. No tests, processes under test, network/JJ commands or Git operations were run. Local files cannot independently authenticate remote host provenance or installed native binary contents. No additional P0–P2 issues found within these evidence claims.

## Resolution — 2026-10-21 (Asia/Shanghai)

**PASS after bounded re-review; the P2 above is resolved.** The original finding and evidence are retained as history.

In the final script, the worker closes its descriptor, sends `closed` and returns to its active IPC listener without exiting (`:55–59`). The parent waits for that acknowledgement, checks null exit/signal status and `process.kill(pid, 0)`, then successfully acquires/releases the lock before asking the owner to exit (`:144–152`). This now distinguishes descriptor-close release from process-exit release.

`lock-pilot-windows-final.json` and `lock-pilot-jj-final.json` each record all nine checks passing and `reacquiredWhileOwnerAlive: true`. Their final script hash matches the current file:

```text
ee0714e7287bc53b9bd72898ca3faf1566b739fa91e62644633c22237d6809d9  scripts/validation/native-file-lock-pilot.cjs
```

Both final reports retain package-lock SHA256 `512ce43748bb2c5f56e04c00be31f30e8e90cc9283e1516bb9c47f90c386e54c`, matching the isolated lockfile. The preserved `.superpowers/sdd/2026-10-21-task-recovery-source/native-file-lock-pilot-initial.cjs` hashes to the original `96760ff6a3e4efd9d897280098b8b19898494fd8c173176923344549eb93fb74`. The final uncontended measurements are 229.4848 microseconds/operation on Windows and 8.234124 on JJ; these remain single-run synthetic measurements. The pathname result still explicitly measures the limitation rather than claiming protection.

This follow-up inspected only the changed close clause, final saved evidence and relevant hashes. No tests, network/JJ execution or Git operations were run by this reviewer. No remaining P0–P2 finding in that scope; Task 1 codec PASS is unchanged.
