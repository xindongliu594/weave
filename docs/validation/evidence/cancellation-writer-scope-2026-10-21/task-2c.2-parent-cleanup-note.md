# Parent cleanup record

Root invoked cleanup-2c.2-fixtures.ps1 only after each corresponding original runner completed. RED fixture MJz8My, first native GREEN Y9xWvV, bounded regression MhK39d, final native GREEN ZjnBGF were validated as exact owned Temp children; ancestor/descendant reparse and resolved identity checks passed, native PowerShell LiteralPath removals each exited0. Actual output is in task-2c.2-red-cleanup.log, task-2c.2-green-cleanup.log, task-2c.2-final-cleanup.log.

The initial root invocation under sandbox exited1 before deletion: GetTempPath referred to the sandbox Packages/.../AC/Temp while actual runner fixture was in native user Temp. The SAME script, with no relaxed validation, succeeded in native execution. That refusal was setup/path validation, not a product result.

Interrupted early GREEN and initial sandbox runner failure did not record exact cleanup target identity; those possible fixture remnants remain unverified, not deleted by matching prefix or age. Root later ran native read-only Win32_Process inventory for node command lines containing the maintenance test (both slash forms) or archive-writer-source-child.mjs: actual exit0, no matching process. Implementer separately saved a process check. No unknown process was killed, no guard unlock/reset API was used.
