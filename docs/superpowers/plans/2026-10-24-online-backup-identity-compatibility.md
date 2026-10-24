# Online backup identity compatibility

This is a compatibility repair required by the approved A2 authority fields, not the completion of F1 enterprise backup.

Existing implementation reviewed: `backup.ts` exports a bounded encrypted business-table package; `backup-destination.ts` already prevents replacement of enterprise identity/audit history; `verify-mvp-full-offline-backup.mjs` only verifies a stopped local filesystem copy. None is a complete online enterprise identity-preserving restore. Reuse the current table locks, encryption, import validation, and isolated HTTP fixture. Do not invent identities, erase authority fields, or silently turn a human-authorized run into local-owner authority.

1. Add failing direct HTTP tests for exporting protected enterprise data and importing human-authorized business-only records. Check rejection before filesystem staging and preservation of source/target rows, key and files.
2. Reuse the protected-table check for export, before the first repeatable-read snapshot is taken; use source-specific errors. Keep legacy non-enterprise export/restore working.
3. Reject incoming authority records whose identity dependencies cannot be preserved by this package, before staging or SQL replacement.
4. Run the isolated backup protection suite, relevant size/checkpoint regressions, and type checking. Record exact results. No browser, model, production, installation, or destructive restore experiment.

Full enterprise backup, identity-preserving restore, key rotation, and deployment rollback remain F1 work. A rejected legacy export is a correctly described limitation, not a verified enterprise backup.
