# 06 · Phases and verification gates

Rule: finish a phase, pass its gate **with evidence**, commit, update `docs/PROGRESS.md`, stop and report. Do not start the next phase until the user says "continue".

Priority if time runs short: phases 0 to 5 are the product. 6 is the showpiece. 7 is polish and submission. Never skip a gate to gain time.

---

## Phase 0 · Scaffold and contracts
**Build**
- npm workspaces monorepo: `apps/web`, `apps/server`, `packages/shared` (existing files stay).
- `tsconfig.base.json` (strict), ESLint, Prettier, Vitest config per workspace.
- Root scripts: `typecheck`, `lint`, `test`, `test:sim`, `test:e2e`, `build`, `verify`, `dev`.
- `packages/shared/src/index.ts` re-exporting types, hlc, merge. Make shared consumable by both apps.

**Gate**
- `npm install` clean. `npm run verify` passes (shared's 14 unit tests and the simulation run and pass).
- `npm run dev` starts server on :3001 and web on :3000 with a placeholder page that shows the text from `GET /api/health`.
- Evidence: paste `verify` output.

## Phase 1 · Shared core hardening
**Build**
- Add fast-check property tests mirroring the 6 simulation invariants, with 3 and 5 devices and 1000 runs.
- Add edge-case tests #4, #6, #7 (device clock at 1970), #8, #9 from the testing plan if not already covered.
- Do NOT change merge behavior unless a failing test proves a bug (see AGENTS.md).

**Gate**
- All shared tests pass. Mutation check: temporarily change one merge rule (for example always apply sets), show the suite fails, then revert. Paste both outputs.

## Phase 2 · Server
**Build**
- Fastify app: routes in `04_DATA_MODEL_AND_SYNC_PROTOCOL.md`, zod validation, SQLite repo with the schema and one transaction per push.
- `/ws` broadcast `{type:"changed", seq}` after state changes.
- Seed 12 households and `POST /api/dev/reset`.
- Pull by `seq`. Preview never persists.

**Gate (server integration tests, Fastify `inject`)**
- Push creates and sets; duplicate push returns `duplicate` and changes nothing.
- Out-of-order set returns `rejected` and succeeds after the create.
- Concurrent field edit opens a conflict; resolve works; double resolve refused.
- Preview returns predicted statuses and persists nothing (assert row counts).
- Restart persistence: close and reopen the DB, state intact.
- Bad input returns 400.
- Evidence: test output plus a `curl` transcript of one push and one pull.

## Phase 3 · Client local-first (no sync yet)
**Build**
- Dexie schema, derived `view`, outbox writes inside one transaction, `meta` (deviceId, userId, HLC).
- UI: Records list, search, filter chips, New household, Record detail with instant edits, delete with Undo, user switcher (Meera, Dev, Arjun).
- PWA: manifest, Workbox precache, navigation fallback. Offline banner using browser events for now.
- Per-record and per-field badges from the outbox (everything local shows Pending).

**Gate**
- Client unit tests for outbox, view derivation, op building (`baseHlc`, `seen`).
- Playwright: load once online, `setOffline(true)`, create, edit, delete, reload, data still there. Cold start offline after closing the browser context and reopening with the same storage.
- Browser-verify against `02_UX_SPEC.md` screens 1 and 2 at 360px and 1280px. Attach screenshots.

## Phase 4 · Sync engine and connectivity
**Build**
- Heartbeat plus events connectivity module (injectable clock and fetch).
- Push in batches of 50, pull by cursor, backoff, resume, single-tab lock.
- Status machine and top-bar states from the UX spec. `aria-live` announcements.
- WebSocket hint triggers pull. Live list updates preserve scroll and focus, and the "changed while you were editing" note.

**Gate**
- Client tests with a fake transport: response lost then retry gives no duplicates; drop mid-batch then resume; captive-portal case (`onLine` true, heartbeat fails); 500-op backlog.
- Playwright scenarios 1 and 6 from the testing plan pass.
- Evidence: Playwright report and a short recording of kill-network, edit, reconnect, live update on a second context.

## Phase 5 · Conflicts and Sync preview
**Build**
- Pull mirrors conflicts into Dexie. Conflict inbox per UX spec, all three kinds, resolution actions via the resolve endpoint, live collapse on resolution.
- Sync preview sheet using `/api/sync/preview`.
- Field-level "Review conflict" link on record detail.

**Gate**
- Playwright scenarios 2, 3, 4 pass.
- Manual-in-browser verification of the full walkthrough in `01_PRD.md` steps 1 to 9. Attach screenshots of each step.
- Confirm no scenario ever loses an edit (inspect server `ops` table versus UI).

## Phase 6 · Showpiece: Chaos Mode, timeline, dashboard
**Build**
- Client transport wrapper with profiles: Normal, Offline, Flaky 30%, Slow, Partition. Per-device, persisted.
- Live op timeline from `opLog`. "Run convergence check" button running the shared simulation in the browser and showing seed and result.
- Dashboard (counts, recent activity, audit trail) and `/api/stats`, `/api/audit`.

**Gate**
- Playwright scenario 7 (Flaky) passes.
- The convergence button shows green for 200 seeds in under 10 seconds on a laptop (report actual time).
- Audit trail shows a full conflict lifecycle for the demo scenario.

## Phase 7 · Hardening, docs, deployment
**Build**
- Accessibility pass (keyboard path, contrast, reduced motion, live regions). Fix findings.
- README final: architecture diagram (image or Mermaid), key decisions, how to run, how to test, demo script, known limitations, AI disclosure. Evidence folder per the testing plan.
- Deploy a single service over HTTPS. Seed data. Verify install prompt, cold-start offline, and a two-device demo on the deployed URL.
- Backup demo recording of the conflict flow.

**Gate**
- `npm run verify` and `npm run test:e2e` green from a clean clone.
- Deployed URL passes the 5 success criteria in `01_PRD.md`.
- Edge-case table in `docs/evidence/` complete, every row linked to a passing test.

---

## Stop conditions (apply in every phase)
Stop and ask the user if: a gate fails twice for the same reason; a spec conflict is found; you need to change a provided file's behavior; or scope would grow. Report what you tried and what you need.
