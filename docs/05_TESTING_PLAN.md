# 05 · Testing plan

Testing, edge cases and reliability is 15% of the score, and it is also how we prove the headline claim. Tests are written **before or with** the feature they cover.

## Layers
| Layer | Tool | What it proves |
|---|---|---|
| Unit: shared | Vitest | HLC, merge rules, resolution, preview (provided: 14 tests) |
| Simulation: shared | Vitest (seeded PRNG) | Convergence and no-loss under random partitions (provided: 200 sessions) |
| Property-based | fast-check | Same invariants with shrinking counterexamples (phase 1 adds this) |
| Server integration | Vitest + Fastify `inject` | Endpoints, persistence, transactions, idempotent push, preview never persists |
| Client unit | Vitest + fake-indexeddb | Outbox, view derivation, status machine, backoff, connectivity logic |
| E2E | Playwright (two browser contexts) | Real offline behavior, real sync, real conflicts, cold-start offline |

## Provided invariants (already enforced by `convergence.sim.test.ts`)
1. All devices end identical to the server after healing.
2. Every submitted op reaches a terminal, non-rejected outcome.
3. Every conflicted op is held by a conflict (recoverable).
4. No conflicts remain open after resolution.
5. Replaying the whole log yields only `duplicate` and no state change.
6. No silent overwrite: an applied `set` replaces a different value only if the author had seen it.
The provided suite was mutation-checked: forcing "always apply sets" makes it fail. Keep it that way when you extend it.

## Edge-case matrix (each needs an automated test)
| # | Case | Layer |
|---|---|---|
| 1 | Duplicate delivery of a batch | server integration, sim |
| 2 | Response lost after server applied, client retries | client + fake transport |
| 3 | Connection drops mid-batch, resume | client + fake transport |
| 4 | Out-of-order: set arrives before create | shared unit, server integration |
| 5 | Edit-vs-delete and delete-vs-edit, both orders | shared unit, E2E |
| 6 | Same field, same value from two devices (no-op) | shared unit |
| 7 | Clock skew ±5 s and a device clock set to 1970 | sim, client |
| 8 | Chained offline edits on a conflicted field | shared unit |
| 9 | Double resolve of one conflict | shared unit, server integration |
| 10 | Preview never persists | server integration |
| 11 | `navigator.onLine` true but heartbeat fails (captive portal) | client unit |
| 12 | Cold start offline after a full browser restart | E2E |
| 13 | Dexie schema upgrade with a non-empty outbox | client unit |
| 14 | Two tabs: only one runs the sync loop | client unit |
| 15 | Large offline backlog (500 ops) syncs in batches without duplicates | client + server |
| 16 | Remote change to a field the user is editing: input preserved | E2E |
| 17 | Server restart during sync | server integration + client |
| 18 | Invalid or oversized push body rejected with 400 | server integration |

## E2E scenarios (Playwright, two contexts A and B, one server)
1. **Happy path:** A and B load online; A goes offline (`context.setOffline(true)`), edits, reconnects; B sees the change live.
2. **Merge:** both offline; A edits notes, B edits phone; reconnect both; both fields present everywhere; zero conflicts.
3. **Conflict:** both offline; both edit status differently; reconnect; conflict appears with ancestor, mine, theirs; resolve; both screens converge.
4. **Edit-vs-delete:** A deletes, B edits; reconnect; conflict appears; resolve with Restore; both converge.
5. **Cold start offline:** load once online, close, set offline, reopen: app shell and data load.
6. **Interrupted sync:** drop the network after the first batch of a large backlog; restore; no duplicates, all ops applied once.
7. **Chaos:** set Flaky 30% on B, edit 20 records, reconnect; eventually consistent, zero lost edits.

## Verification gate command
`npm run verify` must run, in order: typecheck (all workspaces) → lint → unit tests → server integration tests → simulation tests → build. Playwright E2E is `npm run test:e2e` and is required from phase 3 onward. Any failure stops the phase.

## Evidence to ship (collected in `docs/evidence/`)
- Terminal output of `npm run verify` and `npm run test:sim` (with seed count).
- Playwright HTML report and the recorded video of the conflict scenario.
- A one-page table mapping each edge case above to its test name and status.
- Honest "known limitations" list in the README.

## Anti-flakiness rules
- Inject time and randomness (`now`, PRNG) everywhere in logic; never read `Date.now()` in merge.
- E2E waits on observable UI states (`aria-live` text or badge text), never on fixed sleeps.
- Every randomized test prints its seed on failure.
