# Antigravity prompts

## How to set up
1. Create a new folder `synctrail`, open it as the workspace in Antigravity.
2. Paste every file from this kit into the same paths (the shared code and tests are already verified).
3. If your Antigravity version does not auto-load `AGENTS.md`, copy its content into a workspace rule as well.
4. Use the Manager view. Planning mode for phases 0, 2, 4, 5. Fast mode is fine for small fixes.
5. Paste the **Kickoff prompt** below once. After each phase report, review the evidence, then send the **Continue prompt**.

---

## Kickoff prompt (paste once)

```
You are building SyncTrail for a hackathon (ALG-WEB-02, Offline-First Application). The judges
reward: a working core, synchronization correctness, conflict handling, UX, and testing beyond
the happy path. Our differentiator is a "no silent data loss" guarantee.

Before writing any code:
1. Read AGENTS.md, then docs/01_PRD.md, 02_UX_SPEC.md, 03_ARCHITECTURE.md,
   04_DATA_MODEL_AND_SYNC_PROTOCOL.md, 05_TESTING_PLAN.md, 06_PHASES.md, PROGRESS.md.
2. Inspect packages/shared. It is already implemented and verified (14 unit tests and a
   200-session randomized convergence simulation). Run its tests first and confirm they pass.
   Do not rewrite it. Extend it only as docs/06_PHASES.md allows.
3. Write a short implementation plan for PHASE 0 only, then proceed without waiting for approval.

Operating rules (from AGENTS.md, repeated because they matter):
- Work strictly one phase at a time in the order of docs/06_PHASES.md.
- A phase is done only when its GATE passes with evidence: real command output, and for UI
  work, browser-driven verification with screenshots using the browser agent. "Should work" is
  not evidence.
- When a phase gate passes: run `npm run verify`, update docs/PROGRESS.md (state, evidence,
  commit), make one git commit "phase-N: <summary>", then STOP and send me a report in this
  format:
    PHASE N REPORT
    Built: <bullets>
    Gate results: <each gate item, PASS or FAIL, with the evidence>
    Deviations or decisions: <anything that differs from the docs, and why>
    Risks and what I need from you: <or "none">
    Next phase: <name, and its first three tasks>
- Do not start the next phase until I reply "continue".
- If a gate fails, fix the cause and rerun. If it fails twice for the same reason, or the spec
  is ambiguous or contradictory, stop and ask. Never weaken, skip, or delete a test to pass.
- Do not add scope: no authentication, no extra entities, no second app, no new libraries
  beyond the stack in AGENTS.md without justifying it in PROGRESS.md.
- Merge logic lives only in packages/shared/src/merge.ts. Never duplicate it in client or server.
- Be honest in reports. If something is partly working, say so.

Start now with PHASE 0. Finish it, verify it, and report.
```

---

## Continue prompt (paste after reviewing each report)

```
continue

Proceed to the next phase in docs/06_PHASES.md. Before building, re-read that phase and its
gate, and re-read AGENTS.md invariants. Plan briefly, build, then verify against the gate with
real evidence (command output plus browser-driven checks where the phase includes UI).
Finish with the same PHASE N REPORT format and stop.
```

## Failure recovery prompt (use when a gate fails or output looks wrong)

```
Stop building. Do a root-cause review of what just failed.
1. Show the exact failing command or scenario and its output.
2. State the root cause in one or two sentences, with the file and line.
3. Check whether the cause violates an invariant in AGENTS.md or a rule in
   docs/04_DATA_MODEL_AND_SYNC_PROTOCOL.md.
4. Write a failing test that reproduces it BEFORE fixing.
5. Fix, rerun the full gate for this phase, and report the before and after output.
Do not change unrelated files.
```

## Review prompt (optional, run after phase 5 and again after phase 7)

```
Act as a skeptical hackathon judge for ALG-WEB-02. Using the running app and the repo, try to
break the "no silent data loss" claim: two devices, same field, edit-vs-delete in both orders,
duplicate delivery, interrupted sync, clock set to 1970, cold start offline, a 500-op backlog.
Report every case where an edit disappeared, duplicated, or where the UI state was untruthful.
For each, give steps to reproduce and a proposed fix. Do not fix anything yet.
```
