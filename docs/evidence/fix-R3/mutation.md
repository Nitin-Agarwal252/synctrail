# fix-R3 mutation check (run in .mutation-tmp/, real files untouched)

Note: a first attempt symlinked the whole node_modules, so `@synctrail/shared` in the web tests still resolved to the real (unmutated) package. Rerun below with `node_modules/@synctrail/*` pointing into the temp copy (`readlink -f` = `.mutation-tmp/packages/shared`).

## SHA256 before
```
caf1f6ad601329ddd67b1b4a012c95898595bb01288f7b2057fbfdb47d3f85d8  packages/shared/src/types.ts
02e016b29de92f404538b778666f830e3f831687bdb820abe70cc9f0b6228048  packages/shared/src/hlc.ts
1388e8a15632a00f3d920ad5aea8f9d56b01545cdc1945da2b69e7a40c014bd3  packages/shared/src/merge.ts
7cc411b8ea17c38444143211ef20f3469495b7678d85d731bc5ffdda938c3144  packages/shared/src/merge.test.ts
8e69943b5a0365e660378fd19cf3709295fedb829b85c5d26952d2887175f5f5  packages/shared/src/convergence.sim.test.ts
```
## Mutant: sets always apply (no field conflict, no edit-vs-delete)
```diff
--- a/packages/shared/src/merge.ts	2026-10-04 11:49:49.617161827 +0000
+++ b/packages/shared/src/merge.ts	2026-10-04 11:49:49.633161792 +0000
@@ -146,11 +146,10 @@
         return { opId: op.opId, status: 'conflict', conflictId: open.id };
       }
 
-      if (rec.deleted) return openConflict(state, op, rec, 'edit-vs-delete', field);
 
       const cur = rec.fields[field];
       if (cur && cur.value === value) return done('noop');
-      if (!cur || cur.hlc === op.baseHlc) {
+      if (cur === cur) {
         writeField(rec, field, value, op.hlc, op.opId, op.deviceId, op.userId);
         return done('applied');
       }
```
## packages/shared sim.module.test.ts
```
   × runSimulation (sim.ts) > holds all 7 invariants across 200 seeded sessions, and is not vacuous 1654ms
   × runSimulation (sim.ts) > the 7th invariant alone catches a delete that ignores what the deleter saw 185ms
   × runSimulation (sim.ts) > compareWithLastWriteWins: SyncTrail loses 0 edits, naive LWW loses some on the same seeds 321ms
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 3 ⎯⎯⎯⎯⎯⎯⎯
AssertionError: seed 1: 19 sets replaced or dropped an unseen value, first: op7: expected { …(3) } to match object { pass: true, …(1) }
AssertionError: expected false to be true // Object.is equality
AssertionError: expected 311 to be +0 // Object.is equality
      Tests  3 failed | 2 passed (5)
```
## apps/web simChecklist.test.ts + temp-only mutationProbe.test.ts (Chaos page view logic)
```
   × Chaos page checklist view (fix-R3) > shows 7 green rows and the measured time for the real merge 210ms
SUMMARY tone=fail: 1 of 7 invariants broken · first failing seed 1 · 1873 ms measured
ROW Pass | Convergence: every device ends identical to the server | held in all 200 seeds
ROW Pass | No lost operation: every op reached a non-rejected outcome | held in all 200 seeds
ROW Pass | Every conflicted op is held in a conflict (recoverable) | held in all 200 seeds
ROW Pass | All conflicts are resolved after the human step | held in all 200 seeds
ROW Pass | Idempotent replay: re-applying the whole log changes nothing | held in all 200 seeds
ROW Fail | No silent overwrite: a set only replaces a value its author saw | seed 1: 19 sets replaced or dropped an unseen value, first: op7
ROW Pass | No silent delete: an applied delete never removes another author's unseen edit | held in all 200 seeds
 ✓ src/pages/mutationProbe.test.ts (1 test) 1875ms
   ✓ mutation probe: broken merge makes runSimulation fail and the Chaos checklist red 1875ms
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯
      Tests  1 failed | 2 passed (3)
```
## SHA256 after (identical)
```
caf1f6ad601329ddd67b1b4a012c95898595bb01288f7b2057fbfdb47d3f85d8  packages/shared/src/types.ts
02e016b29de92f404538b778666f830e3f831687bdb820abe70cc9f0b6228048  packages/shared/src/hlc.ts
1388e8a15632a00f3d920ad5aea8f9d56b01545cdc1945da2b69e7a40c014bd3  packages/shared/src/merge.ts
7cc411b8ea17c38444143211ef20f3469495b7678d85d731bc5ffdda938c3144  packages/shared/src/merge.test.ts
8e69943b5a0365e660378fd19cf3709295fedb829b85c5d26952d2887175f5f5  packages/shared/src/convergence.sim.test.ts
```
