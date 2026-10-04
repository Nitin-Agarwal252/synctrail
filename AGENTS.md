# AGENTS.md — SyncTrail (read this first, every session)

SyncTrail is an offline-first field-survey app for ALGOTHON'26 problem ALG-WEB-02.
Its promise: **no silent data loss**. Judges score synchronization correctness, conflict handling, and UX.

## Read order
1. `docs/01_PRD.md` (what and why)
2. `docs/02_UX_SPEC.md` (screens, states, copy)
3. `docs/03_ARCHITECTURE.md` and `docs/04_DATA_MODEL_AND_SYNC_PROTOCOL.md` (how)
4. `docs/05_TESTING_PLAN.md` and `docs/06_PHASES.md` (how we prove it, in what order)
5. `docs/PROGRESS.md` (where we are now)

## Non-negotiable invariants
1. Every change is an immutable **op** with a unique `opId`. The server dedupes by `opId`. Retries must be safe.
2. A `set` applies only if the field is unchanged since the author saw it (`cur.hlc === op.baseHlc`). Otherwise it becomes a **Conflict**. Never last-write-wins.
3. Different fields on one record merge automatically. Identical values are a no-op.
4. Deletes are tombstones. Edit-vs-delete is a conflict in both orders.
5. Correctness never depends on wall clocks. Use the HLC in `packages/shared`.
6. `packages/shared/src/merge.ts` is the ONLY place merge logic lives. It stays pure (no I/O, no `Date.now()`, no randomness). Client and server both import it. Do not re-implement merge elsewhere.
7. Never trust `navigator.onLine` alone. Connectivity = browser events + a real heartbeat to `/api/health`.
8. Conflicts are data, not errors. They never block other sync work.
9. The UI always shows: connection state, outbox count, and a per-record sync state with icon plus label (never color alone).

## Already provided and verified (do not rewrite, only extend with tests)
`packages/shared/src/{types,hlc,merge}.ts` and their tests. If you believe one is wrong, write a failing test that proves it first, then fix it, and note it in `docs/PROGRESS.md`.

## Working rules
- Work **one phase at a time** per `docs/06_PHASES.md`. Do not begin phase N+1 until phase N's gate has passed with evidence.
- Evidence means command output and, for UI, browser-driven verification (screenshots or recordings). "It should work" is not evidence.
- After each phase: run `npm run verify`, update `docs/PROGRESS.md`, make one git commit `phase-N: <summary>`, then STOP and report.
- If a requirement is ambiguous, ask. Do not invent scope. No auth system, no extra entities, no second app.
- Do not mock the sync path in tests that claim to test sync. Use the real engine with a fake transport.
- Never weaken or delete a test to make it pass. Fix the code or ask.
- Keep functions small, TypeScript `strict`, no `any`, no dead code, no TODOs left behind.

## Stack (equivalents allowed only if you justify them in PROGRESS.md)
Monorepo (npm workspaces): `apps/web` (Next.js PWA or Vite+React PWA), `apps/server` (Node + Fastify + `ws`, SQLite via better-sqlite3), `packages/shared`.
Client storage: Dexie (IndexedDB). Service worker: Workbox. Tests: Vitest, fast-check (phase 1), Playwright (two browser contexts).

## Disclosure
The hackathon requires disclosure of AI-assisted components. Keep the "AI disclosure" section in `README.md` accurate.
