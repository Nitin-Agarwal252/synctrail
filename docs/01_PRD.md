# 01 · Product requirements — SyncTrail

## One-liner
An offline-first field-survey app with a **no-silent-data-loss guarantee**: edits made offline always survive, non-overlapping edits merge automatically, and real conflicts are shown to a human with full context.

## Problem (ALG-WEB-02)
Web apps become unusable or unsafe when connectivity is unstable. Most "offline" apps are a queue plus last-write-wins, which silently discards someone's work.

## Core idea
Treat every change as an immutable operation. Merge per field using a three-way check. Keep conflicts as first-class data. Prove convergence with randomized network-partition tests, and make that proof visible in the demo.

## Pain points
| # | Pain | How SyncTrail answers |
|---|---|---|
| 1 | Silent data loss from last-write-wins | Field-level three-way merge; true conflicts are held, never overwritten |
| 2 | "Is my change saved?" anxiety | Per-record and global sync state, outbox counter, last-synced time |
| 3 | Duplicates after interrupted sync | Idempotent ops by `opId`, resumable batches |
| 4 | Browser says online but requests fail | Heartbeat-based connectivity, not `navigator.onLine` alone |
| 5 | Opaque "A or B?" conflict dialogs | Conflict inbox with ancestor, both versions, authors, times |
| 6 | Wrong phone clocks corrupt ordering | HLC; correctness does not depend on wall time |
| 7 | Edit vs delete destroys work | Tombstones plus an explicit edit-vs-delete conflict |

## Users
- **Primary: field worker** (health or survey worker, inspector, delivery or sales staff). Hours without signal. Needs to create, edit, delete records without thinking about connectivity.
- **Secondary:**
  - Supervisor (office): consumes synced data, resolves escalated conflicts, reads the audit trail.
  - Teammate (second field worker on the same records): the source of conflicts.
  - Admin or developer: sync health and audit view.
  - Hackathon judge: uses Chaos Mode and the test dashboard.

## Domain (keep it to one)
Community health survey. Entity: **Household** with fields `name`, `phone`, `address`, `status` (`new` | `follow-up` | `completed`), `notes`. Seed 8 to 12 households and 3 users: Meera, Dev (field), Arjun (supervisor).

## User walkthrough (the demo script)
1. Morning, online. Meera and Dev open the installed PWA. Households cache to IndexedDB. Pill: "Synced".
2. Signal drops. Banner: "You're offline. Changes are safe and will sync when you reconnect."
3. Meera edits Household #42: notes and status. Row shows Pending. Outbox: "2 waiting".
4. Dev edits #42 phone and status, and deletes #57.
5. Meera reconnects first. Sync preview: "2 changes merge cleanly". She syncs. Badges turn Synced.
6. Dev reconnects. Preview: phone merges cleanly; status on #42 conflicts; #57 delete conflicts with Meera's edit.
7. Dev resolves in the conflict inbox (ancestor, mine, theirs, authors, times). Meera's screen updates live.
8. Arjun's dashboard shows final state plus the audit trail.
9. Edge: Dev's connection dies mid-sync. It resumes with no duplicates.

## Scope
**In:** installable PWA, cold-start offline, local-first CRUD on Households, outbox, connectivity detection, idempotent resumable sync, field-level merge, conflict inbox, sync preview, edit-vs-delete handling, live updates (WebSocket), supervisor dashboard with audit trail, Chaos Mode, test suite, deployed demo.

**Out:** real authentication (use a user switcher), file attachments, character-level text merge (stretch only), multi-tenant admin, push notifications.

## Success criteria (judge-facing)
1. Kill the network live, edit, reconnect: data survives and statuses are truthful.
2. Two devices edit the same record offline: different fields merge, same field opens a conflict, nothing is overwritten.
3. Edit-vs-delete shows a conflict in both orders.
4. Randomized convergence suite is green and visible (`npm run test:sim`).
5. Interrupted sync and duplicate delivery produce no duplicates.

## Judging map
| Criterion (weight) | Where we win |
|---|---|
| Functionality 30% | All six required items plus conflicts, working end to end |
| Technical 20% | Op log, HLC, pure shared merge engine, idempotency |
| Innovation 20% | Sync preview, conflict inbox, Chaos Mode, edit-vs-delete |
| UX 15% | Honest sync states, calm offline copy, readable conflicts |
| Testing 15% | Randomized convergence simulation, Playwright two-device E2E |
