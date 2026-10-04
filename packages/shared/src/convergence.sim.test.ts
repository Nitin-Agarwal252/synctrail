import { describe, it, expect } from 'vitest';
import { applyOp, applyOptimistic, createServerState, resolveConflict, seenOf } from './merge.ts';
import * as hlc from './hlc.ts';
import type { Hlc, Op, RecordState, ServerState } from './types.ts';

/** Seeded PRNG so any failure is reproducible: re-run with the failing seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Device {
  id: string;
  user: string;
  skew: number; // wrong phone clock, up to +/- 5 s
  clock: Hlc | null;
  view: Record<string, RecordState>;
  pending: Op[];
}

const FIELDS = ['name', 'phone', 'status', 'notes'];
const VALUES = ['a', 'b', 'c', 'd']; // tiny domain on purpose, so equal-value no-ops happen

function runSession(seed: number, steps: number, deviceCount: number) {
  const rand = rng(seed);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  const server: ServerState = createServerState();
  let wall = 1_000_000;
  let opSeq = 0;
  const submitted: Op[] = [];
  const outcome = new Map<string, string>();

  const devices: Device[] = Array.from({ length: deviceCount }, (_, i) => ({
    id: `dev${i}`,
    user: `user${i}`,
    skew: Math.floor((rand() - 0.5) * 10_000),
    clock: null,
    view: {},
    pending: [],
  }));

  const now = (d: Device) => wall + d.skew;
  const nextHlc = (d: Device): Hlc => (d.clock = hlc.tick(d.clock, d.id, now(d)));
  const push = (d: Device, o: Op) => {
    d.view[o.recordId] = applyOptimistic(d.view[o.recordId], o) as RecordState;
    d.pending.push(o);
    submitted.push(o);
  };

  function act(d: Device) {
    const live = Object.values(d.view).filter((r) => !r.deleted);
    const dead = Object.values(d.view).filter((r) => r.deleted);
    const roll = rand();
    const base = { deviceId: d.id, userId: d.user, baseHlc: null as Hlc | null };
    if (live.length === 0 || roll < 0.12) {
      const o: Op = { ...base, opId: `op${++opSeq}`, type: 'create', recordId: `r${++opSeq}`, hlc: nextHlc(d), fields: { name: pick(VALUES), phone: pick(VALUES) } };
      push(d, o);
    } else if (roll < 0.8) {
      const r = pick(live);
      const field = pick(FIELDS);
      push(d, { ...base, opId: `op${++opSeq}`, type: 'set', recordId: r.id, field, value: pick(VALUES), baseHlc: r.fields[field]?.hlc ?? null, hlc: nextHlc(d) });
    } else if (roll < 0.92) {
      const r = pick(live);
      push(d, { ...base, opId: `op${++opSeq}`, type: 'delete', recordId: r.id, seen: seenOf(r), hlc: nextHlc(d) });
    } else if (dead.length) {
      push(d, { ...base, opId: `op${++opSeq}`, type: 'restore', recordId: pick(dead).id, hlc: nextHlc(d) });
    }
  }

  function sync(d: Device, duplicateDelivery: boolean) {
    for (const o of d.pending) {
      const before = o.type === 'set' ? server.records[o.recordId]?.fields[o.field as string] : undefined;
      const res = applyOp(server, o);
      outcome.set(o.opId, res.status);
      // No silent overwrite: an applied set may replace a DIFFERENT value only if the author had seen it.
      if (res.status === 'applied' && before && before.value !== o.value && before.hlc !== o.baseHlc) {
        throw new Error(`silent overwrite by ${o.opId}`);
      }
      if (duplicateDelivery && rand() < 0.3) applyOp(server, o); // retry after a dropped ACK
    }
    d.pending = [];
    d.view = structuredClone(server.records);
    for (const r of Object.values(d.view)) d.clock = hlc.receive(d.clock, r.version, d.id, now(d));
  }

  for (let i = 0; i < steps; i++) {
    wall += Math.floor(rand() * 500);
    const d = pick(devices);
    if (rand() < 0.2) sync(d, true);
    else act(d);
  }

  // Heal the partition: everyone syncs, then a person resolves every open conflict.
  for (const d of devices) sync(d, true);
  const resolver = devices[0];
  for (const c of server.conflicts.filter((x) => x.status === 'open')) {
    const choice = c.kind === 'delete-vs-edit' ? pick(['mine', 'theirs'] as const) : pick(['mine', 'theirs', 'custom'] as const);
    const r = nextHlc(resolver);
    resolveConflict(server, c.id, choice === 'custom' ? { choice, value: 'merged' } : { choice }, { userId: resolver.user, deviceId: resolver.id, opId: r, hlc: r });
  }
  for (const d of devices) sync(d, false);

  return { server, devices, submitted, outcome };
}

describe('convergence under random partitions', () => {
  it('holds all invariants across 200 seeded sessions', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const { server, devices, submitted, outcome } = runSession(seed, 300, 3);
      const ctx = `seed=${seed}`;

      // 1. Convergence: every device ends identical to the server.
      for (const d of devices) expect(JSON.stringify(d.view)).toBe(JSON.stringify(server.records));

      // 2. No lost operation: every submitted op reached a terminal, non-rejected outcome.
      for (const o of submitted) {
        const s = outcome.get(o.opId);
        if (s === undefined || s === 'rejected') throw new Error(`${ctx}: op ${o.opId} outcome=${s}`);
      }

      // 3. Every op that was NOT applied is recoverable: noop (same value) or held in a conflict.
      for (const o of submitted) {
        if (outcome.get(o.opId) !== 'conflict') continue;
        const held = server.conflicts.some(
          (c) => c.recordId === o.recordId && c.mine.deviceId === o.deviceId && (o.type === 'delete' ? c.kind === 'delete-vs-edit' : c.field === o.field),
        );
        if (!held) throw new Error(`${ctx}: conflicted op ${o.opId} not held by any conflict`);
      }

      // 4. All conflicts resolved after the human step.
      expect(server.conflicts.filter((c) => c.status === 'open')).toHaveLength(0);

      // 5. Idempotency: replaying the entire log changes nothing and reports only duplicates.
      const before = JSON.stringify(server.records);
      for (const o of server.log) {
        const s = applyOp(server, o).status;
        if (s !== 'duplicate') throw new Error(`${ctx}: replay of ${o.opId} returned ${s}`);
      }
      expect(JSON.stringify(server.records)).toBe(before);
    }
  });

  it('actually exercises conflicts (the simulation is not vacuous)', () => {
    let conflicts = 0;
    for (let seed = 1; seed <= 20; seed++) conflicts += runSession(seed, 300, 3).server.conflicts.length;
    expect(conflicts).toBeGreaterThan(20);
  });
});
