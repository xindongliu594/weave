# SDD ledger — plan: docs/validation/acceptance-evidence-separation-2026-10-19.md

Pre-flight: API guard and UI share standalone Node syntax classifier; historical runtime contracts and receipt hashes are unchanged.
Task 1: RED observed 5 expected failures; implementation in progress.

Task 1: complete — 40 local tests including untouched real replies and actual Node subprocess failures passed.
Task 2: complete — 31 isolated API tests passed; typecheck/build passed.
Final: fixed direct Node argument-value bypass — review-red.txt RED; 40 tests GREEN.
Final: fixed legacy model-preview confirmation bypass — confirmation-red.txt RED; 31 API tests GREEN.
Final: Ruling: manually authored/previously confirmed legacy contracts remain compatible; this guard applies to new model plans and unconfirmed model previews. Existing runtime seals are not rewritten; arbitrary shell behavior and natural-language coverage still need independent QA.

Task 3: complete — JJ 100 unit/runtime + 54 isolated API checks passed; deployed with verified hashes, healthy service, zero active runs; browser confirmed warning and cancelled editing.
Final review: one P2 fixed RED→GREEN; no deferred minors.
