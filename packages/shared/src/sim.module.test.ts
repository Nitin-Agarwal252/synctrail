import { describe, it, expect } from 'vitest';
import { compareWithLastWriteWins, runSimulation, INVARIANTS } from './sim.ts';
import { lastWriteWinsApply } from './lwwHarness.ts';
import { applyOp } from './merge.ts';
import type { ApplyFn } from './sim.ts';

describe('runSimulation (sim.ts)', () => {
  it('holds all 7 invariants across 200 seeded sessions, and is not vacuous', () => {
    const r = runSimulation({ seeds: 200, steps: 300, devices: 3 });
    expect(r.invariants.map((i) => i.name)).toEqual(INVARIANTS.map((i) => i.name));
    expect(r.invariants).toHaveLength(7);
    for (const inv of r.invariants) expect(inv, inv.detail).toMatchObject({ pass: true, detail: 'held in all 200 seeds' });
    expect(r.pass).toBe(true);
    expect(r.failingSeed).toBeNull();
    expect(r.elapsedMs).toBeGreaterThan(0);
    expect(r.counts.ops).toBeGreaterThan(200 * 100);
    expect(r.counts.conflictsOpened).toBeGreaterThan(200);
    expect(r.counts.duplicatesReplayed).toBeGreaterThan(r.counts.ops);
  });

  it('is deterministic per seed', () => {
    const a = runSimulation({ seeds: 10, steps: 200, devices: 3 });
    const b = runSimulation({ seeds: 10, steps: 200, devices: 3 });
    expect(a.counts).toEqual(b.counts);
  });

  it('reports failing invariants and the first failing seed for a last-write-wins apply', () => {
    const r = runSimulation({ seeds: 20, steps: 300, devices: 3, apply: lastWriteWinsApply });
    expect(r.pass).toBe(false);
    expect(r.failingSeed).not.toBeNull();
    const byName = Object.fromEntries(r.invariants.map((i) => [i.name, i]));
    expect(byName[INVARIANTS[5].name].pass).toBe(false);
    expect(byName[INVARIANTS[6].name].pass).toBe(false);
    expect(byName[INVARIANTS[6].name].detail).toMatch(/^seed \d+: \d+ deletes removed unseen edits/);
  });

  it('the 7th invariant alone catches a delete that ignores what the deleter saw', () => {
    const blindDelete: ApplyFn = (state, op) =>
      op.type === 'delete' && state.records[op.recordId] && !state.records[op.recordId].deleted
        ? applyOp(state, { ...op, seen: Object.fromEntries(Object.entries(state.records[op.recordId].fields).map(([f, fs]) => [f, fs.hlc])) })
        : applyOp(state, op);
    const r = runSimulation({ seeds: 20, steps: 300, devices: 3, apply: blindDelete });
    expect(r.invariants[6].pass).toBe(false);
    expect(r.invariants[5].pass).toBe(true);
  });

  it('compareWithLastWriteWins: SyncTrail loses 0 edits, naive LWW loses some on the same seeds', () => {
    const c = compareWithLastWriteWins({ seeds: 20, steps: 300, devices: 3 });
    expect(c.sessions).toBe(20);
    expect(c.syncTrail.lostEdits).toBe(0);
    expect(c.lastWriteWins.lostEdits).toBeGreaterThan(0);
  });
});
