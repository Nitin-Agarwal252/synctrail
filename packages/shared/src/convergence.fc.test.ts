import { describe, it } from 'vitest';
import fc from 'fast-check';
import { applyOp, applyOptimistic, createServerState, resolveConflict, seenOf } from './merge.ts';
import * as hlc from './hlc.ts';
import type { Hlc, Op, RecordState, ServerState } from './types.ts';

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
  is1970: boolean;
  skew: number; // up to +/- 1 hour (3,600,000 ms)
  clock: Hlc | null;
  view: Record<string, RecordState>;
  pending: Op[];
}

const FIELDS = ['name', 'phone', 'status', 'notes'] as const;
const VALUES = ['a', 'b', 'c', 'd'] as const;

function runFcSession(
  seed: number,
  steps: number,
  deviceCount: number,
  customSkews?: number[],
) {
  const rand = rng(seed);
  const pick = <T,>(xs: readonly T[] | T[]): T => xs[Math.floor(rand() * xs.length)];
  const server: ServerState = createServerState();
  let modernWall = 1_770_000_000_000; // modern base timestamp (2026)
  let opSeq = 0;
  const submitted: Op[] = [];
  const outcome = new Map<string, string>();

  // Device configuration with hostile clocks:
  // - Device 0 is stuck near 1970 (wall close to 0)
  // - Devices 1..deviceCount-1 have skew up to +/- 1 hour (3,600,000 ms)
  const devices: Device[] = Array.from({ length: deviceCount }, (_, i) => ({
    id: `dev${i}`,
    user: `user${i}`,
    is1970: i === 0,
    skew:
      i === 0
        ? 0
        : customSkews && customSkews[i - 1] !== undefined
          ? customSkews[i - 1]
          : Math.floor((rand() - 0.5) * 7_200_000), // +/- 1 hour
    clock: null,
    view: {},
    pending: [],
  }));

  const getDeviceWall = (d: Device): number => {
    if (d.is1970) {
      // Stuck near 1970 epoch (wall close to 0, e.g. 50..5000 ms)
      return (opSeq * 10) % 5000 + 50;
    }
    return modernWall + d.skew;
  };

  const nextHlc = (d: Device): Hlc => (d.clock = hlc.tick(d.clock, d.id, getDeviceWall(d)));

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
      const o: Op = {
        ...base,
        opId: `op${++opSeq}`,
        type: 'create',
        recordId: `r${++opSeq}`,
        hlc: nextHlc(d),
        fields: { name: pick(VALUES), phone: pick(VALUES) },
      };
      push(d, o);
    } else if (roll < 0.8) {
      const r = pick(live);
      const field = pick(FIELDS);
      push(d, {
        ...base,
        opId: `op${++opSeq}`,
        type: 'set',
        recordId: r.id,
        field,
        value: pick(VALUES),
        baseHlc: r.fields[field]?.hlc ?? null,
        hlc: nextHlc(d),
      });
    } else if (roll < 0.92) {
      const r = pick(live);
      push(d, {
        ...base,
        opId: `op${++opSeq}`,
        type: 'delete',
        recordId: r.id,
        seen: seenOf(r),
        hlc: nextHlc(d),
      });
    } else if (dead.length) {
      push(d, {
        ...base,
        opId: `op${++opSeq}`,
        type: 'restore',
        recordId: pick(dead).id,
        hlc: nextHlc(d),
      });
    }
  }

  function sync(d: Device, duplicateDelivery: boolean) {
    for (const o of d.pending) {
      const before = o.type === 'set' ? server.records[o.recordId]?.fields[o.field as string] : undefined;
      const res = applyOp(server, o);
      outcome.set(o.opId, res.status);

      // Invariant 6: No silent overwrite
      if (res.status === 'applied' && before && before.value !== o.value && before.hlc !== o.baseHlc) {
        throw new Error(`Invariant 6 violated: silent overwrite by op ${o.opId}`);
      }

      if (duplicateDelivery && rand() < 0.3) {
        applyOp(server, o); // duplicate delivery retry
      }
    }
    d.pending = [];
    d.view = structuredClone(server.records);
    for (const r of Object.values(d.view)) {
      d.clock = hlc.receive(d.clock, r.version, d.id, getDeviceWall(d));
    }
  }

  for (let i = 0; i < steps; i++) {
    modernWall += Math.floor(rand() * 500);
    const d = pick(devices);
    if (rand() < 0.2) sync(d, true);
    else act(d);
  }

  // Phase A: Heal the partition (everyone syncs)
  for (const d of devices) sync(d, true);

  // Phase B: Resolve all open conflicts
  const resolver = devices[0];
  for (const c of server.conflicts.filter((x) => x.status === 'open')) {
    const choice =
      c.kind === 'delete-vs-edit'
        ? pick(['mine', 'theirs'] as const)
        : pick(['mine', 'theirs', 'custom'] as const);
    const rHlc = nextHlc(resolver);
    resolveConflict(
      server,
      c.id,
      choice === 'custom' ? { choice, value: 'merged' } : { choice },
      { userId: resolver.user, deviceId: resolver.id, opId: rHlc, hlc: rHlc },
    );
  }

  // Phase C: Final sync
  for (const d of devices) sync(d, false);

  return { server, devices, submitted, outcome };
}

function assertInvariants(result: ReturnType<typeof runFcSession>, ctx: string) {
  const { server, devices, submitted, outcome } = result;

  // 1. Convergence: every device ends identical to the server.
  const serverJson = JSON.stringify(server.records);
  for (const d of devices) {
    if (JSON.stringify(d.view) !== serverJson) {
      throw new Error(`${ctx}: device ${d.id} failed to converge with server`);
    }
  }

  // 2. No lost operation: every submitted op reached a terminal, non-rejected outcome.
  for (const o of submitted) {
    const s = outcome.get(o.opId);
    if (s === undefined || s === 'rejected') {
      throw new Error(`${ctx}: op ${o.opId} outcome=${s}`);
    }
  }

  // 3. Every op that was NOT applied is recoverable: noop (same value) or held in a conflict.
  for (const o of submitted) {
    if (outcome.get(o.opId) !== 'conflict') continue;
    const held = server.conflicts.some(
      (c) =>
        c.recordId === o.recordId &&
        c.mine.deviceId === o.deviceId &&
        (o.type === 'delete' ? c.kind === 'delete-vs-edit' : c.field === o.field),
    );
    if (!held) {
      throw new Error(`${ctx}: conflicted op ${o.opId} not held by any conflict`);
    }
  }

  // 4. All conflicts resolved after the human step.
  const openConflicts = server.conflicts.filter((c) => c.status === 'open');
  if (openConflicts.length > 0) {
    throw new Error(`${ctx}: ${openConflicts.length} conflicts remained open`);
  }

  // 5. Idempotency: replaying the entire log changes nothing and reports only duplicates.
  const before = JSON.stringify(server.records);
  for (const o of server.log) {
    const s = applyOp(server, o).status;
    if (s !== 'duplicate') {
      throw new Error(`${ctx}: replay of ${o.opId} returned ${s}`);
    }
  }
  if (JSON.stringify(server.records) !== before) {
    throw new Error(`${ctx}: server records mutated during log replay`);
  }
}

describe('fast-check convergence properties (hostile clocks, 3 & 5 devices, 1000 runs)', () => {
  it('holds all 6 invariants across 1000 runs with 3 devices (including +/-1h skew and 1970 clock)', () => {
    fc.assert(
      fc.property(
        fc.record({
          seed: fc.integer({ min: 1, max: 2_147_483_647 }),
          skews: fc.array(fc.integer({ min: -3_600_000, max: 3_600_000 }), { minLength: 2, maxLength: 2 }),
        }),
        ({ seed, skews }) => {
          const res = runFcSession(seed, 150, 3, skews);
          assertInvariants(res, `3-devices seed=${seed}`);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('holds all 6 invariants across 1000 runs with 5 devices (including +/-1h skew and 1970 clock)', () => {
    fc.assert(
      fc.property(
        fc.record({
          seed: fc.integer({ min: 1, max: 2_147_483_647 }),
          skews: fc.array(fc.integer({ min: -3_600_000, max: 3_600_000 }), { minLength: 4, maxLength: 4 }),
        }),
        ({ seed, skews }) => {
          const res = runFcSession(seed, 150, 5, skews);
          assertInvariants(res, `5-devices seed=${seed}`);
        },
      ),
      { numRuns: 1000 },
    );
  });
});
