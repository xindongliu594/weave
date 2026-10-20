# Independent review: isolated native PostgreSQL identity fixture

Date: 2026-10-20. Baseline HEAD: `d38cfa7377f06dce8b426aac70bddca716d0da30`; reviewed the uncommitted fixture and runner changes. This is a safety/scope review, not frontend re-review, release approval, or permission to activate JJ enterprise OIDC.

## Scope and conclusion

Reviewed `tests/fixtures/identity/postgres.ts`, `tests/identity-postgres-guard.test.ts`, the optional native branch in `tests/fixtures/identity/idp.ts`, the owned `native-oidc-probe.mjs` runner, and the later `drainMaintenance()`/protocol test synchronization delta. A second read-only reviewer independently inspected runner path, credential, and shutdown handling. Neither reviewer started another cluster, connected to a database, accessed a production endpoint, or called a model.

**No unresolved definite P1/P2 issue remains in this reviewed safety scope after the runner cleanup repair below.** The configured native run and its final evidence remain the parent's responsibility; this review does not substitute a passing guard test for native PostgreSQL acceptance.

## Connection and schema boundaries

- The native fixture requires the explicit `IDENTITY_TEST_POSTGRES_URL` branch. Missing that variable continues to use the prior private PGlite fixture; an empty or invalid explicit variable fails rather than falling back. Neither the new pool factory nor that branch reads ambient `DATABASE_URL`.
- Before opening a connection, the guard accepts only `postgres:`/`postgresql:`, loopback host spelling, exact user `weiwu_test`, a supplied password, an explicit valid port, and database name `weiwu_identity_test_<32 lowercase hex>`. Query parameters and fragments are rejected, so caller-supplied libpq options cannot broaden schema targeting.
- Each pool creates its own `oidc_<random UUID hex>` schema. The application pool applies only that schema as its search path on every connection, uses a bounded eight-connection pool and connection/statement deadlines, and uses the unchanged production `migrateIdentity` implementation. Schema identifiers contain only a fixed prefix and random hex.
- `end()` drains that pool before a separate connection drops only its exact generated schema. Cleanup is memoized and migration failure also invokes cleanup. No production migration, principal check, CSRF rule, audit restriction, or session lifecycle constraint was relaxed.
- Existing `identity-store.test.ts` still has its preexisting `DATABASE_URL` entry point. The owned runner strips the ambient value and supplies the generated private test URL deliberately for that suite; this review did not run that suite directly against the ambient environment.

## Owned runner boundaries

The scratch dependency is local to the validation directory and pins `@embedded-postgres/windows-x64` to `17.10.0-beta.17`; the runner also checks the executable reports PostgreSQL 17.10. It generates a random cluster directory, password, and test database, strips inherited PostgreSQL/DB test target variables, initializes SCRAM authentication, and binds the server to `127.0.0.1` on a selected ephemeral port. No ambient database URL or production credential is used as the target.

The password is supplied to `initdb` through a temporary file rather than a command-line value. Child test URLs contain only this generated password and stay in child environment variables. The runner's result/error output redacts the raw generated password; evidence contains no intentionally logged connection string. Windows creation modes do not establish a separate ACL boundary, so these are private local test artifacts rather than a cross-account secret store.

Before recursive data removal, the runner checks the exact ownership marker, resolved root/data paths and containment, and requires `pg_ctl status` to confirm the owned instance has stopped. On a failed run it keeps data/evidence instead of deleting it. It neither enumerates nor deletes unrelated PostgreSQL directories. Read-only filesystem inspection found `.superpowers`, `sdd`, and the current validation owner directory are ordinary directories, with no junction/reparse link indicated.

## Resolved [P2] cleanup could wait forever for a leaked checked-out client

The initial runner acquired both lock-probe clients before entering their release `try`, and awaited rollback before either release. A failure during the second acquire or during rollback could leak a checked-out client. Its outer `finally` then awaited unbounded `pool.end()` before removing the password file or reaching `pg_ctl stop`.

This was reproduced without any database using the installed `pg.Pool` with a fake client: first connect succeeded, second connect failed, and `pool.end()` remained pending with one checked-out client until it was explicitly released.

The parent repaired the runner by moving acquisitions inside `try`, placing both `release(true)` calls in nested `finally` blocks that run even if rollback fails, removing the password file before pool drain, and bounding final pool drain to three seconds while keeping owned-instance shutdown reachable.

Fresh pure failure-injection verification using the installed pool confirmed both repaired failure cases release all clients and complete pool shutdown:

```json
[{"scenario":"second-connect-fails","drainFinished":true,"remainingClients":0},{"scenario":"rollback-fails","drainFinished":true,"remainingClients":0}]
```

## Maintenance synchronization delta

`drainMaintenance()` only awaits the existing bounded cleanup Promise; it does not initiate cleanup, create an HTTP route, change authorization, or alter SQL. `close()` still marks the service closed and cancels the interval before waiting for maintenance and closing the store. Replacing arbitrary `SELECT 1` timing loops with this Promise waits for actual cleanup over independent PostgreSQL connections. The tests retain their original exact 500-child bound, root retention, final cleanup and valid-session assertions. No acceptance assertion was removed to make the native run pass.

## Verification and limits

Fresh reviewer command:

```text
node --import tsx --test tests/identity-postgres-guard.test.ts
```

Result: **1 passing, 0 failing, 0 skipped**, exit code 0. This is pure URL guard evidence. Additional fake-client probes covered the cleanup failure/repair without network access. The reviewer did not independently run native PostgreSQL, production migrations, protocol endpoints, trusted-browser TLS, or the release suite.

Optional hardening for a future reusable runner: validate `ownerRoot`'s real path before startup as well as before deletion, and attach an immediate rejection handler to the pending lock-query Promise to avoid noisy unhandled rejections on exceptional probe paths. Neither was demonstrated to compromise or leave the current ordinary owned-directory run active. The runner does not claim protection against an attacker concurrently replacing its private validation directories.
