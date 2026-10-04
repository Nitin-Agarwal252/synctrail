# Edge-case table

Every edge case from `docs/05_TESTING_PLAN.md` is linked to the **exact title** of an automated test.
`npm run verify` runs `scripts/check-edge-table.mjs` (`npm run check:edges`), which fails if any cited
title is not found in the cited test file, if a row cites no test, or if a case is missing.

Last verified: fix-R4 · `npm run verify` (includes the checker) and `npm run test:e2e` green.

| # | Case | Layer | Tests (file → exact title) | Status |
|---|---|---|---|---|
| 1 | Duplicate delivery of a batch | server integration, sim | `app.test.ts` → "Push creates and sets; duplicate push returns duplicate and changes nothing"; `sim.module.test.ts` → "holds all 7 invariants across 200 seeded sessions, and is not vacuous" | ✅ Pass |
| 2 | Response lost after server applied, client retries | client + fake transport | `sync.test.ts` → "response lost after server applied, client retries: no duplicates" | ✅ Pass |
| 3 | Connection drops mid-batch, resume | client + fake transport, E2E | `sync.test.ts` → "drop mid-batch then resume: only remaining ops are sent"; `sync-engine.spec.ts` → "Scenario 6: Interrupted sync — 120-op backlog, network cut after the first push succeeds, restored, each opId on the server exactly once" | ✅ Pass |
| 4 | Out-of-order: set arrives before create | shared unit, server integration | `edge-cases.test.ts` → "Edge Case #4: set arriving before create is rejected, not marked seen, and succeeds on retry"; `app.test.ts` → "Out-of-order set returns rejected and succeeds after create" | ✅ Pass |
| 5 | Edit-vs-delete and delete-vs-edit, both orders | shared unit, E2E | `edge-cases.test.ts` → "Edge Case #5: edit-vs-delete and delete-vs-edit in both orders open conflict and preserve data"; `conflicts.spec.ts` → "Scenario 4: Edit-vs-delete — A deletes, B edits offline → conflict → Restore → both converge" | ✅ Pass |
| 6 | Same field, same value from two devices (no-op) | shared unit | `edge-cases.test.ts` → "Edge Case #6: same field set to same value by two concurrent devices is a no-op with no conflict" | ✅ Pass |
| 7 | Clock skew ±1 h and a device clock set to 1970 | shared unit, property-based | `edge-cases.test.ts` → "Edge Case #7: a device with a 1970 clock edits and syncs with others with no lost edit and no silent overwrite"; `convergence.fc.test.ts` → "holds all 6 invariants across 1000 runs with 3 devices (including +/-1h skew and 1970 clock)"; `convergence.fc.test.ts` → "holds all 6 invariants across 1000 runs with 5 devices (including +/-1h skew and 1970 clock)" | ✅ Pass |
| 8 | Chained offline edits on a conflicted field | shared unit | `edge-cases.test.ts` → "Edge Case #8: chained offline edits fold into a single open conflict preserving latest offline intent" | ✅ Pass |
| 9 | Double resolve of one conflict | shared unit, server integration | `edge-cases.test.ts` → "Edge Case #9: double resolve of a conflict is refused and does not alter resolved state"; `app.test.ts` → "Concurrent field edit opens a conflict; resolve works; double resolve refused" | ✅ Pass |
| 10 | Preview never persists | server integration | `app.test.ts` → "Preview returns predicted statuses and persists nothing (assert row counts)" | ✅ Pass |
| 11 | `navigator.onLine` true but heartbeat fails (captive portal) | client unit | `sync.test.ts` → "captive-portal case: onLine true but heartbeat fails -> offline" | ✅ Pass |
| 12 | Cold start offline after a full browser restart | E2E | `offline-crud.spec.ts` → "cold start offline after full browser restart" | ✅ Pass |
| 13 | Dexie schema upgrade with a non-empty outbox | client unit | `migration.test.ts` → "preserves existing outbox rows and adds an empty deadOps table" | ✅ Pass |
| 14 | Two tabs: only one runs the sync loop | client unit (real engine, real `WebTabLock`, in-memory lock manager) | `tabLock.test.ts` → "only the lock holder pushes, it pushes edits made in the other tab, and the other tab takes over when it stops" | ✅ Pass |
| 15 | Large offline backlog (500 ops) syncs in batches without duplicates | client + fake transport | `sync.test.ts` → "500-op backlog syncs in batches of 50 without duplicates" | ✅ Pass |
| 16 | Remote change to a field the user is editing: input preserved | E2E | `sync-engine.spec.ts` → "Edge Case #16: Remote change while user is editing preserves active input" | ✅ Pass |
| 17 | Server restart during sync | client (real engine + HTTP transport) + real server process | `restartDuringSync.test.ts` → "push fails because the server dies mid-sync; restarted on the same DB file, the engine resumes and every op is applied exactly once"; `app.test.ts` → "Restart persistence: close and reopen the DB, state intact" | ✅ Pass |
| 18 | Invalid or oversized push body rejected (413 / 400) | server integration | `limits.test.ts` → "an oversized push body returns 413 and persists nothing"; `limits.test.ts` → "51 ops (over the batch limit) and a malformed JSON body each return 400"; `opValidation.test.ts` → "keeps 400 for malformed envelopes only" | ✅ Pass |

## Evidence files

| Phase | Location | Description |
|---|---|---|
| 3 | `docs/evidence/phase-3/` | Records list at 360px and 1280px, offline state |
| 4 | `docs/evidence/phase-4/videos/` | Scenario 1 two-context sync video |
| 5 | `docs/evidence/phase-5/` | Conflict card (Scenario 3), resolved state, edit-vs-delete Restore (Scenario 4) |
| 6 | `docs/evidence/phase-6/` | Chaos Flaky profile, dashboard, audit lifecycle (`convergence-check-pass.png` shows the pre-fix-R3 check) |
| fix-R1 | `docs/evidence/fix-R1/` | Dead-letter list after a server reset; mutation output |
| fix-R2 | `docs/evidence/fix-R2/` | Both devices after a reset; mutation output |
| fix-R3 | `docs/evidence/fix-R3/` | Real 7-invariant checklist; mutation output |
| fix-R4 | `docs/evidence/fix-R4/` | Production build served by the server (local and Docker), smoke test output |

## Test commands

```bash
npm run verify       # typecheck, lint, edge-table check, unit tests, sim, build
npm run test:e2e     # Playwright (two browser contexts)
BASE_URL=https://<host> npm run test:smoke   # short check against a running deployment
```
