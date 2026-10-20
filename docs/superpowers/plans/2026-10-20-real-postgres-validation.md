# Real PostgreSQL validation environment

Status: environment preparation, not an enterprise feature or production deployment.

## Existing capability and research

The current test runner creates a disposable PGlite socket server per file. Its single backend cannot prove independent row-lock/session races. The existing execution-policy tests explicitly skip two such cases. Windows has no postgres/initdb/pg_ctl/psql or Docker command. A read-only SSH probe of JJ found Docker but the user cannot access its socket; PostgreSQL commands are absent. Do not change that permission or inspect production credentials.

Reuse the PostgreSQL binaries packaged by leinelissen/embedded-postgres, rather than implement a database or require a system service. Official PostgreSQL also offers ZIP binaries. Sources inspected 2026-10-20:

- https://github.com/leinelissen/embedded-postgres — upstream binary packaging, supported platforms, postinstall symlink requirement.
- https://www.postgresql.org/download/windows/ — binary ZIP installation option.
- npm registry metadata for @embedded-postgres/windows-x64@17.10.0-beta.17: unpacked 101598126 bytes; integrity sha512-q6xIETTkv67i1QlTWz1LAKb3Z+vG2V3qrp+BjLEWhCQ9jE4hbbsQ/J/3wiOPFLJbuwak7CfHC9EUJG7txAbGKw==. The package release suffix is beta.17; check the actual PostgreSQL executable version before relying on it.

## Selected boundary

Install only the fixed Windows binary package in a plan-owned ignored dependency directory, with lifecycle scripts disabled. Inspect any required hydration script before running the minimal package-provided operation. Do not add it to product dependencies, JJ releases or the root lock. No system service, administrator/user creation, Docker permission, public listener, model API or production configuration is involved.

1. Save a private isolated package/lock and install the pinned package with ignore-scripts. Inspect its shipped paths and scripts. Run the three version commands. Record executable SHA256 and exact version.
2. Build a bounded disposable test harness around standard initdb/pg_ctl using a random directory under this plan workspace, an ownership marker, loopback-only random port and generated test credentials. Preserve failed evidence; stop the exact owned cluster before any cleanup. Never recursively remove a caller-supplied database path. Validate an existing owned live process instead of restarting merely after an observation timeout.
3. Prove two independent PostgreSQL backend PIDs and actual blocking/release on a transaction row lock; test isolation and cleanup failure. An unavailable native runtime is a failed preflight, not a reason to fake concurrency.
4. Run focused identity bootstrap/session lifecycle races against the actual identity schema. Run actual canonical merge races once B2 Task3 is independently reviewed, using current production code and complete supported fixture schema. Use independent connections, deterministic barriers and no sleeps as correctness evidence.
5. Full application migrations require pgvector. The binary package alone does not prove pgvector availability. Keep full application/PostgreSQL/JJ gates incomplete until a matching supported extension or isolated existing environment is available; do not rewrite vector migrations or substitute another type to make them pass.
6. Save small output/versions/run IDs and explicit exclusions; retain the reusable binary cache in the ignored plan directory, and remove only owned stopped disposable data. Review the harness before treating its result as a release gate.

This preparation can proceed while source reviews are in flight because it does not modify their product files or enable the task execution profile. It does not complete B2 Task6, A1 browser deployment or the overall goal.
