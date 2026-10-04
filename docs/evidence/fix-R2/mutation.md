# fix-R2 mutation check (run in .mutation-tmp/, real files untouched)

## SHA256 before
```
caf1f6ad601329ddd67b1b4a012c95898595bb01288f7b2057fbfdb47d3f85d8  packages/shared/src/types.ts
02e016b29de92f404538b778666f830e3f831687bdb820abe70cc9f0b6228048  packages/shared/src/hlc.ts
1388e8a15632a00f3d920ad5aea8f9d56b01545cdc1945da2b69e7a40c014bd3  packages/shared/src/merge.ts
7cc411b8ea17c38444143211ef20f3469495b7678d85d731bc5ffdda938c3144  packages/shared/src/merge.test.ts
8e69943b5a0365e660378fd19cf3709295fedb829b85c5d26952d2887175f5f5  packages/shared/src/convergence.sim.test.ts
066709854b7cc7a4aeac37a395bef2fccf2917be70342d7af1185e3c220d11bc  apps/web/src/sync/engine.ts
```
## Mutant A: pulls not serialized
```diff
609,611c609
<     const run = this.pullChain.then(() => this.pullOnce());
<     this.pullChain = run.catch(() => undefined);
<     return run;
---
>     return this.pullOnce();
```
```
   × R2 pull robustness > concurrent pulls run one at a time; a stale response never moves the cursor back or overwrites newer data 62ms
   ✓ R2 pull robustness > randomized: with random seqs and delays the observed cursor is monotonic 483ms
   ✓ R2 pull robustness > a failing hint pull is caught, and the safety pull keeps running while leader 1271ms
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯
      Tests  1 failed | 5 passed (6)
```
## Mutant B: cursor and snapshot overwritten by any response
```diff
650c650,651
<         if (!cur || record.seq > cur.seq) await this.db.snapshot.put(record);
---
>         void cur;
>         await this.db.snapshot.put(record);
658c659,660
<       await this.db.setMeta('cursor', String(Math.max(cursor, res.seq)));
---
>       void cursor;
>       await this.db.setMeta('cursor', String(res.seq));
```
```
   × R2 pull robustness > concurrent pulls run one at a time; a stale response never moves the cursor back or overwrites newer data 54ms
   × R2 pull robustness > randomized: with random seqs and delays the observed cursor is monotonic 31ms
   ✓ R2 pull robustness > a failing hint pull is caught, and the safety pull keeps running while leader 1275ms
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯
      Tests  2 failed | 4 passed (6)
```
## SHA256 after (identical)
```
caf1f6ad601329ddd67b1b4a012c95898595bb01288f7b2057fbfdb47d3f85d8  packages/shared/src/types.ts
02e016b29de92f404538b778666f830e3f831687bdb820abe70cc9f0b6228048  packages/shared/src/hlc.ts
1388e8a15632a00f3d920ad5aea8f9d56b01545cdc1945da2b69e7a40c014bd3  packages/shared/src/merge.ts
7cc411b8ea17c38444143211ef20f3469495b7678d85d731bc5ffdda938c3144  packages/shared/src/merge.test.ts
8e69943b5a0365e660378fd19cf3709295fedb829b85c5d26952d2887175f5f5  packages/shared/src/convergence.sim.test.ts
066709854b7cc7a4aeac37a395bef2fccf2917be70342d7af1185e3c220d11bc  apps/web/src/sync/engine.ts
```
