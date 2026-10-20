# Local regression process failures — bounded root observation

2026-10-20, current API/product accepted-stop cohort. This is an unresolved test-process incident, not a diagnosed production defect or proof of an external environment fault.

- `api-stop-final-tests.txt` contains two `Fatal process out of memory: Zone` messages; scope test file subsequently exits as a file-level failure. Do not count that final aggregate as green. Earlier individual tests/logs remain historical evidence only.
- `product-stop-pre-reviewfix-whole-file-process-failure.txt` records a different whole-file exit after 185.193 seconds with only `test failed`; no original worker exit/signal or timeout diagnostic. Cause remains unknown. Do not assert it is the same OOM or exclude a product/test resource defect without evidence.
- Root did not interrupt or kill either owner's test runner. No global process termination, heap increase, production limit change, budget change, install or JJ write was performed.
- Read-only Windows sample after these failures: FreePhysicalMemory=12,482,984 KiB, TotalVisibleMemorySize=32,735,592 KiB; FreeVirtualMemory=6,503,356 KiB, TotalVirtualMemorySize=36,929,896 KiB. The postfailure sample does not establish peak consumption or root cause. Process sampling was bounded to Node id/working/private memory, no command lines/credentials were read into evidence.
- Coordinate heavy tests across owners: product per-pattern fresh PGlite/TAP first, explicit child code/signal/elapsed/timedOut and start/end source SHA. API owner continues read-only review while paused from starting new heavy runs; missing API files must later be rerun serially. Per-pattern green is functional evidence, not proof of repeated multi-run same-process stability.
- Follow-up full Task5 terminal capacity/stability gate includes sequential runs on one executor/journal; do not erase this incident or claim long-running robustness from isolated cases alone.
