# fix-R1 mutation check (run in .mutation-tmp/, real files untouched)

## SHA256 before
```
caf1f6ad601329ddd67b1b4a012c95898595bb01288f7b2057fbfdb47d3f85d8  packages/shared/src/types.ts
02e016b29de92f404538b778666f830e3f831687bdb820abe70cc9f0b6228048  packages/shared/src/hlc.ts
1388e8a15632a00f3d920ad5aea8f9d56b01545cdc1945da2b69e7a40c014bd3  packages/shared/src/merge.ts
7cc411b8ea17c38444143211ef20f3469495b7678d85d731bc5ffdda938c3144  packages/shared/src/merge.test.ts
8e69943b5a0365e660378fd19cf3709295fedb829b85c5d26952d2887175f5f5  packages/shared/src/convergence.sim.test.ts
1b2f8da8ccf2f4b5c5a905eb48a2f37cffb4baf26c86736c4f0029bb03bff53d  apps/web/src/sync/engine.ts
```
## Mutant: restore 'delete whole batch after any successful HTTP response'
```diff
-        removed += await this.applyPushResults(batch, res.results);
+        void res;
+        await this.db.outbox.bulkDelete(batch.map((b) => b.n as number));
+        removed += batch.length;
```
## vitest output (temp copy)
```
   × R1 dead-letter: per-op push results > rejected(unknown-record) is kept in the outbox, then dead-lettered after 5 attempts 49ms
   × R1 dead-letter: per-op push results > rejected(unknown-record) is dead-lettered once a pull confirms the record is absent 11ms
   × R1 dead-letter: per-op push results > rejected(unknown-record) for a record the client had synced (server reset) is dead-lettered at once 23ms
   × R1 dead-letter: per-op push results > an unknown-record op whose create is still queued stays queued (no false dead-letter) 10ms
   × R1 dead-letter: per-op push results > rejected(invalid-op) is dead-lettered immediately with the server reason 4ms
   × R1 dead-letter: per-op push results > conflict results leave the outbox (held server-side as a Conflict) 4ms
   × R1 dead-letter: per-op push results > Retry moves a dead op back to the outbox; Discard deletes it only when asked 6ms
   × R1 accounting invariant (randomized result statuses) > submitted = accepted + conflicted + still-queued + dead-lettered, for every seed 54ms
 ✓ src/sync/sync.test.ts (5 tests) 549ms
   ✓ Sync Engine & Connectivity (Phase 4) > 500-op backlog syncs in batches of 50 without duplicates 386ms
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 8 ⎯⎯⎯⎯⎯⎯⎯
 FAIL  src/sync/deadLetter.test.ts > R1 dead-letter: per-op push results > rejected(unknown-record) is kept in the outbox, then dead-lettered after 5 attempts
 FAIL  src/sync/deadLetter.test.ts > R1 dead-letter: per-op push results > rejected(unknown-record) is dead-lettered once a pull confirms the record is absent
 FAIL  src/sync/deadLetter.test.ts > R1 dead-letter: per-op push results > rejected(unknown-record) for a record the client had synced (server reset) is dead-lettered at once
 FAIL  src/sync/deadLetter.test.ts > R1 dead-letter: per-op push results > an unknown-record op whose create is still queued stays queued (no false dead-letter)
 FAIL  src/sync/deadLetter.test.ts > R1 dead-letter: per-op push results > rejected(invalid-op) is dead-lettered immediately with the server reason
 FAIL  src/sync/deadLetter.test.ts > R1 dead-letter: per-op push results > conflict results leave the outbox (held server-side as a Conflict)
 FAIL  src/sync/deadLetter.test.ts > R1 dead-letter: per-op push results > Retry moves a dead op back to the outbox; Discard deletes it only when asked
 FAIL  src/sync/deadLetter.test.ts > R1 accounting invariant (randomized result statuses) > submitted = accepted + conflicted + still-queued + dead-lettered, for every seed
 Test Files  1 failed | 1 passed (2)
      Tests  8 failed | 7 passed (15)
```
## SHA256 after (identical)
```
caf1f6ad601329ddd67b1b4a012c95898595bb01288f7b2057fbfdb47d3f85d8  packages/shared/src/types.ts
02e016b29de92f404538b778666f830e3f831687bdb820abe70cc9f0b6228048  packages/shared/src/hlc.ts
1388e8a15632a00f3d920ad5aea8f9d56b01545cdc1945da2b69e7a40c014bd3  packages/shared/src/merge.ts
7cc411b8ea17c38444143211ef20f3469495b7678d85d731bc5ffdda938c3144  packages/shared/src/merge.test.ts
8e69943b5a0365e660378fd19cf3709295fedb829b85c5d26952d2887175f5f5  packages/shared/src/convergence.sim.test.ts
1b2f8da8ccf2f4b5c5a905eb48a2f37cffb4baf26c86736c4f0029bb03bff53d  apps/web/src/sync/engine.ts
```
