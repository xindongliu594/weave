# Referenced Go capture and audit

Frozen at 2026-10-06 13:06:39 +08:00. NEW helpers preserve complete raw Run JSON in the capture's dedicated `NAME.sources` directory; the main capture references both archive and state, including all original messages/events. Each source and the main file retain the original **50 MiB / 52,428,800-byte** limit. There is no combined Run-source limit, pruning or summary substitution.

The capture variant differs from the original only by its storage-adapter import and final serializer; reverse comparison confirmed every collection/GET, cost-maintenance gate, stable-repeat, Go, permissions and budget guard unchanged. The offline audit wrapper loads every reference, then calls the original audit functions. References bind normalized relative paths inside this capture's own bundle, regular files with no symlink/junction, actual bytes/SHA, original GET source metadata and exact scenario/slot/run/project/department/version. Complete archive sequences and created-snapshot hashes are checked before audit. Old inline captures remain supported. Missing evidence and unknown supplier costs remain blocked.

**20/20 tests passed**, 0 failed, cancelled, skipped or todo: NEW 7 reference regressions plus the original 13 audit regressions. Coverage includes three archives exceeding 50 MiB in aggregate while individually bounded, full object readback, same-size tampering, metadata substitution, traversal/foreign bundles, actual Windows junction rejection, declared/physical overflow, recomputed foreign ownership, legacy inline behavior and finance blocking. Test source hashes stayed unchanged; the log is `go-acceptance-run-references-2026-10-06.txt`.

The provided actual failed v8 archive was only read: 35,894,407 bytes, 3133 events, status `failed`, SHA256 `372df14c5430594c6197fc9f26f316ef217f6a62001ce3817b3582e6df9e5889`. Full identity/sequence/snapshot-hash verification passed; see the small `go-acceptance-run-references-2026-10-06-actual-read.json`. No actual archive copy/backup, original API/DB/model call, employee file or frozen runtime edit occurred. These are engineering fixtures and a failed-archive read, not actual MVP acceptance.

Use the existing authorized capture command with the NEW helper and a NEW output filename; all options are unchanged. `--api=http://127.0.0.1:ACTUAL_PORT/api` needs the actual API port from the current service evidence (replace `ACTUAL_PORT`); the webpage uses port 4310. No historical API port is assumed. Help performs no collection:

```powershell
& 'C:/Users/JJ/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' `
  docs/test-evidence/helpers/capture-go-acceptance-referenced-2026-10-06.mjs --help
```

After the parent's actual capture, run the offline audit with its exact file (the example input filename is a placeholder, not existing evidence):

```powershell
& 'C:/Users/JJ/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' `
  docs/test-evidence/helpers/audit-go-todo-acceptance-referenced-2026-10-06.mjs `
  --capture=docs/test-evidence/NEW-ACTUAL-CAPTURE.json `
  --output=docs/test-evidence/NEW-AUDIT.json
```

Keep the capture filename and its `.sources` directory together and immutable; a foreign bundle or renamed owner is rejected. Optional explicit version arguments remain `--normal-version=N` and `--recovery-version=N`. A single archive/state above 50 MiB, or oversized remaining main metadata, still blocks collection. Actual collection and acceptance remain for the parent operator.

Frozen SHA256:

```text
dc33a0a7a04afd77949c4fcc83c56094b7708d3009bf2b1e00a60caf50327984  docs/test-evidence/helpers/go-acceptance-run-references-2026-10-06.mjs
25402ee4b55339606625cd587f2d75ce297c5635e6b59c179c63d518699dec44  docs/test-evidence/helpers/capture-go-acceptance-referenced-2026-10-06.mjs
cb25ee1384f09527406c7b77e00fd5a51f65a130ee11455f021028399fe5a560  docs/test-evidence/helpers/audit-go-todo-acceptance-referenced-2026-10-06.mjs
6377ff2dd79e4f79023b3fb532e67a10ff9701596237454cfc8c8fd876bc4f10  tests/go-acceptance-run-references.test.mjs
```

Original capture/audit/test hashes remain `350f9a3c…`, `70a88470…`, `edf43be6…`; full hashes are retained in the test log. Frozen runtime `product-runtime.mjs` remains `9c9747ad…`.
