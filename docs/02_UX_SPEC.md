# 02 · UX / UI specification

Principle: **be honest and calm.** The app never hides what it knows, never alarms when nothing is wrong, and never asks the user to understand sync internals.

## Information architecture
```
App shell (top bar: title · connection pill · outbox counter · Sync button · user switcher · menu)
├── Records            /            list, search, filter chips, "New household"
│   └── Record detail  /records/:id fields with per-field state, history strip, delete/restore
├── Conflicts          /conflicts   inbox, three-way resolution
├── Dashboard          /dashboard   supervisor view: counts, recent activity, audit trail
└── Dev tools          /chaos       Chaos Mode panel + live op timeline (visible to everyone, labeled "For judges")
```
Sync preview is a **sheet** opened from the Sync button (not a page).

## Global states (top bar)
| State | Pill text | Icon | Notes |
|---|---|---|---|
| Online, synced | Synced | check | Shows "Last synced HH:MM" in tooltip |
| Online, syncing | Syncing… | refresh (spinning) | Respect `prefers-reduced-motion` |
| Offline | Offline · saved on this device | wifi-off | Banner under the bar, see copy |
| Online, pending | N waiting | clock | Outbox counter, click opens preview |
| Needs a decision | N need a decision | alert-triangle | Links to Conflicts |
| Sync failed (retrying) | Retrying in Ns | alert-circle | Backoff 1s, 2s, 4s … max 30s |

Connection pill and outbox counter are separate elements so "Offline" and "3 waiting" can show together.

## Per-record and per-field states
`local-only → pending → syncing → synced | conflict | failed`
Badge = icon + text, always. Colors: synced = success, pending = warning, syncing = accent, conflict = danger, failed = danger outline, local-only = neutral.

## Screens

### 1. Records
```
┌ SyncTrail · Survey      [Offline · saved on this device] [3 waiting] [Sync ▾] ┐
│ ⚠ You're offline. Changes are safe and will sync when you reconnect.          │
│ [All] [Pending] [Conflicts 1]                         🔍 Search households    │
│ Household #42  Meera · edited 2 min ago                         ⏱ Pending     │
│ Household #57  Deleted on this device                           ⚠ Conflict    │
│ Household #61  Synced 09:12                                     ✓ Synced      │
│                                                    [ + New household ]        │
└────────────────────────────────────────────────────────────────────────────────┘
```
- Search matches name, phone, address, notes (client-side, works offline).
- Filter chips: All, Pending, Conflicts, Deleted.
- Deleted records are hidden by default; the Deleted chip shows them with a Restore action.
- Empty state: headline "Start your first household", body "Add a household. It saves on this device right away, even offline.", button "New household".

### 2. Record detail
```
┌ ← Household #42                                   [2 changes pending] ┐
│ Name    Rao family                                        ✓ Synced   │
│ Phone   98300 11122                                       ⏱ Pending  │
│ Status  [follow-up ▾]                                     ⏱ Pending  │
│ Notes   Needs second visit, child under 5                 ✓ Synced   │
│ Address …                                                            │
│ History 09:41 You set status → follow-up (pending)                   │
│         09:12 Dev set phone (synced)                                 │
│         08:55 Created by Arjun                                       │
│                                           [ Delete household ]       │
└──────────────────────────────────────────────────────────────────────┘
```
- Edits save on blur or Enter, instantly, to IndexedDB. No Save button.
- Field in conflict shows the danger badge and a link "Review conflict".
- Deleting asks for no confirmation modal. It shows a toast "Household deleted. Undo" for 8 seconds (undo = restore op).

### 3. Conflict inbox
```
Conflict inbox                                         2 need a decision
Household #42 · Status
┌ Common ancestor ┐ ┌ Yours · Dev ──┐ ┌ Theirs · Meera ─────┐
│ new             │ │ completed     │ │ follow-up           │
│ 09:00           │ │ 09:38         │ │ 09:41               │
└─────────────────┘ └───────────────┘ └─────────────────────┘
[Keep mine] [Keep theirs] [Edit manually]
Household #57 · You deleted it, Meera edited it     [Restore] [Delete anyway]
```
- Each card names the field, both authors, and times (local time, plus relative).
- `Edit manually` reveals an input pre-filled with theirs; "Save resolution" is the commit.
- After resolving, card collapses with "Resolved. Applied to everyone." and the badge on the record updates live.
- `delete-vs-edit` offers only two choices (no custom value).
- Empty state: headline "No conflicts", body "When two people change the same thing, it shows up here.".

### 4. Sync preview (sheet)
Opens from Sync. Calls `POST /api/sync/preview`.
```
Ready to sync 4 changes
✓ Phone on #42            Merges cleanly
✓ Notes on #61            Merges cleanly
⚠ Status on #42           Conflicts with Meera's change
⚠ #57                     You deleted it, Meera edited it
[ Sync now ]   Conflicts will wait in your inbox. Nothing is overwritten.
```
If everything is clean: "All 4 changes merge cleanly." If offline: Sync is available but the sheet explains "You're offline. Changes will sync automatically."

### 5. Dashboard (supervisor)
Metric cards: Households, Pending ops (all devices if known), Open conflicts, Last sync. Below: recent activity list and the **audit trail** (who changed what, when, which conflicts were resolved by whom). Filter by record.

### 6. Chaos Mode (`/chaos`)
Per-device network profile selector: Normal, Offline, Flaky (30% packet loss), Slow (1 to 3 s latency), Partition (offline until released). Implemented in the client transport wrapper, so no server change. A live **op timeline** lists each op with state transitions: created → queued → sent → applied | noop | duplicate | conflict, plus retries. A "Run convergence check" button runs the shared simulation in-browser and shows pass or fail with the seed.

## Interaction rules
- Optimistic everywhere: every edit is visible immediately and survives reload and cold start.
- Never block on the network. Never show a spinner for a local action.
- Reconnect triggers an automatic sync only if there are no open decisions that the user must see first; otherwise it shows the preview.
- Live updates (WebSocket) patch the list without losing scroll or focus. If a remote change touches a field the user is currently editing, show an inline note "Dev changed this while you were editing" and keep the user's input.

## Copy (follow these; sentence case, no exclamation marks, no "successfully")
| Where | Text |
|---|---|
| Offline banner | You're offline. Changes are safe and will sync when you reconnect. |
| Back online | Back online. Syncing 3 changes… |
| Sync done | All changes synced |
| Sync error | Couldn't reach the server. Retrying in 4s |
| Delete toast | Household deleted. Undo |
| Conflict badge tooltip | Someone else changed this too. Review it in your inbox. |
| Install prompt | Install SyncTrail to open it without a connection |

## Visual design
- Calm, utilitarian, high-contrast; designed for sunlight and one-handed phone use. Mobile first (360px), scales to desktop.
- Tokens (define as CSS variables, light and dark): `--bg`, `--surface`, `--text`, `--text-muted`, `--border`, `--accent`, `--success`, `--warning`, `--danger`. State colors must reach 4.5:1 against their tint.
- Type: system UI stack. 16px base, 13px for metadata. Two weights (400, 500).
- Radius 8px controls, 12px cards. No shadows except focus ring.
- Icons: Lucide or Tabler outline set, 16 to 20px.
- Touch targets at least 44px on mobile.

## Accessibility
- Every state has an icon and a text label.
- Status changes announce via `aria-live="polite"` (connection, sync done, conflict opened).
- Full keyboard path: list → record → edit → conflict resolve.
- `prefers-reduced-motion` disables spinners and transitions.
- Conflict three-way cards are a labeled group; choices are real buttons.

## Responsive
- ≤640px: single column; filter chips scroll horizontally; Conflict three-way cards stack vertically; Sync preview is a bottom sheet.
- ≥1024px: Records is a two-pane master/detail; Chaos timeline docks right.
