/**
 * Reusable seeded simulation of devices editing under random partitions, against the real merge.ts.
 * The session logic is a port of convergence.sim.test.ts (same PRNG and same random choices, so the
 * same seed produces the same session), plus a 7th invariant and counters. Not used for sync.
 */
import { applyOp, applyOptimistic, createServerState, resolveConflict, seenOf } from './merge.ts';
import * as hlc from './hlc.ts';
import { lastWriteWinsApply } from './lwwHarness.ts';
import type { ApplyResult, FieldState, Hlc, Op, RecordState, ServerState } from './types.ts';

export type ApplyFn = (state: ServerState, op: Op) => ApplyResult;

export interface SimulationOptions {
  seeds: number;
  steps: number;
  devices: number;
  /** Defaults to the shared applyOp. Tests inject a broken apply to prove the checks can fail. */
  apply?: ApplyFn;
}

export interface InvariantResult {
  name: string;
  pass: boolean;
  detail: string;
}

export interface SimulationCounts {
  ops: number;
  conflictsOpened: number;
  duplicatesReplayed: number;
}

export interface SimulationResult {
  pass: boolean;
  invariants: InvariantResult[];
  failingSeed: number | null;
  elapsedMs: number;
  seeds: number;
  steps: number;
  devices: number;
  counts: SimulationCounts;
}

export interface LostEditTotals {
  ops: number;
  lostEdits: number;
}

export interface LwwComparison {
  sessions: number;
  syncTrail: LostEditTotals;
  lastWriteWins: LostEditTotals;
  elapsedMs: number;
}

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
  skew: number;
  clock: Hlc | null;
  view: Record<string, RecordState>;
  pending: Op[];
}

interface SessionStats {
  silentOverwrites: string[];
  silentDrops: string[];
  unseenDeletes: string[];
  duplicatesReplayed: number;
}

interface Session {
  server: ServerState;
  devices: Device[];
  submitted: Op[];
  outcome: Map<string, string>;
  stats: SessionStats;
  apply: ApplyFn;
}

const FIELDS = ['name', 'phone', 'status', 'notes'];
const VALUES = ['a', 'b', 'c', 'd'];

/** Records any set that changed or dropped a different value its author had not seen. */
function checkSet(o: Op, before: FieldState | undefined, status: string, stats: SessionStats): void {
  if (o.type !== 'set' || !before || before.value === o.value) return;
  if (status === 'applied' && before.hlc !== o.baseHlc) stats.silentOverwrites.push(o.opId);
  if (status === 'noop') stats.silentDrops.push(o.opId);
}

/** Records an applied delete that removed a field edit by another author the deleter had not seen. */
function checkDelete(o: Op, fieldsBefore: Record<string, FieldState>, status: string, stats: SessionStats): void {
  if (o.type !== 'delete' || status !== 'applied') return;
  const seen = o.seen ?? {};
  for (const [f, fs] of Object.entries(fieldsBefore)) {
    if (fs.userId !== o.userId && seen[f] !== fs.hlc) {
      stats.unseenDeletes.push(`${o.opId} removed ${fs.userId}'s ${f}`);
      return;
    }
  }
}

function runSession(seed: number, steps: number, deviceCount: number, apply: ApplyFn): Session {
  const rand = rng(seed);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  const server: ServerState = createServerState();
  let wall = 1_000_000;
  let opSeq = 0;
  const submitted: Op[] = [];
  const outcome = new Map<string, string>();
  const stats: SessionStats = { silentOverwrites: [], silentDrops: [], unseenDeletes: [], duplicatesReplayed: 0 };

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
      push(d, { ...base, opId: `op${++opSeq}`, type: 'create', recordId: `r${++opSeq}`, hlc: nextHlc(d), fields: { name: pick(VALUES), phone: pick(VALUES) } });
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

  function deliver(o: Op, duplicateDelivery: boolean) {
    const rec = server.records[o.recordId];
    const before = o.type === 'set' && rec ? rec.fields[o.field as string] : undefined;
    const fieldsBefore = o.type === 'delete' && rec ? structuredClone(rec.fields) : {};
    const res = apply(server, o);
    outcome.set(o.opId, res.status);
    checkSet(o, before, res.status, stats);
    checkDelete(o, fieldsBefore, res.status, stats);
    if (duplicateDelivery && rand() < 0.3) {
      if (apply(server, o).status === 'duplicate') stats.duplicatesReplayed++;
    }
  }

  function sync(d: Device, duplicateDelivery: boolean) {
    for (const o of d.pending) deliver(o, duplicateDelivery);
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

  for (const d of devices) sync(d, true);
  const resolver = devices[0];
  for (const c of server.conflicts.filter((x) => x.status === 'open')) {
    const choice = c.kind === 'delete-vs-edit' ? pick(['mine', 'theirs'] as const) : pick(['mine', 'theirs', 'custom'] as const);
    const r = nextHlc(resolver);
    resolveConflict(server, c.id, choice === 'custom' ? { choice, value: 'merged' } : { choice }, { userId: resolver.user, deviceId: resolver.id, opId: r, hlc: r });
  }
  for (const d of devices) sync(d, false);

  return { server, devices, submitted, outcome, stats, apply };
}

type Check = (s: Session) => string | null;

const convergence: Check = (s) => {
  const want = JSON.stringify(s.server.records);
  const off = s.devices.find((d) => JSON.stringify(d.view) !== want);
  return off ? `${off.id} differs from the server` : null;
};

const noLostOp: Check = (s) => {
  const lost = s.submitted.find((o) => {
    const st = s.outcome.get(o.opId);
    return st === undefined || st === 'rejected';
  });
  return lost ? `op ${lost.opId} outcome=${s.outcome.get(lost.opId)}` : null;
};

const conflictsHeld: Check = (s) => {
  const orphan = s.submitted.find(
    (o) =>
      s.outcome.get(o.opId) === 'conflict' &&
      !s.server.conflicts.some(
        (c) => c.recordId === o.recordId && c.mine.deviceId === o.deviceId && (o.type === 'delete' ? c.kind === 'delete-vs-edit' : c.field === o.field),
      ),
  );
  return orphan ? `conflicted op ${orphan.opId} not held by any conflict` : null;
};

const allResolved: Check = (s) => {
  const open = s.server.conflicts.filter((c) => c.status === 'open').length;
  return open ? `${open} conflicts still open` : null;
};

const idempotentReplay: Check = (s) => {
  const before = JSON.stringify(s.server.records);
  for (const o of s.server.log) {
    const st = s.apply(s.server, o).status;
    if (st !== 'duplicate') return `replay of ${o.opId} returned ${st}`;
    s.stats.duplicatesReplayed++;
  }
  return JSON.stringify(s.server.records) === before ? null : 'replay changed the records';
};

const firstOf = (xs: string[], label: string) => (xs.length ? `${xs.length} ${label}, first: ${xs[0]}` : null);

const noSilentOverwrite: Check = (s) =>
  firstOf([...s.stats.silentOverwrites, ...s.stats.silentDrops], 'sets replaced or dropped an unseen value');

const noUnseenDelete: Check = (s) => firstOf(s.stats.unseenDeletes, 'deletes removed unseen edits');

export const INVARIANTS: { name: string; check: Check }[] = [
  { name: 'Convergence: every device ends identical to the server', check: convergence },
  { name: 'No lost operation: every op reached a non-rejected outcome', check: noLostOp },
  { name: 'Every conflicted op is held in a conflict (recoverable)', check: conflictsHeld },
  { name: 'All conflicts are resolved after the human step', check: allResolved },
  { name: 'Idempotent replay: re-applying the whole log changes nothing', check: idempotentReplay },
  { name: 'No silent overwrite: a set only replaces a value its author saw', check: noSilentOverwrite },
  { name: "No silent delete: an applied delete never removes another author's unseen edit", check: noUnseenDelete },
];

export function runSimulation(opts: SimulationOptions): SimulationResult {
  const t0 = performance.now();
  const apply = opts.apply ?? applyOp;
  const failures: (string | null)[] = INVARIANTS.map(() => null);
  const counts: SimulationCounts = { ops: 0, conflictsOpened: 0, duplicatesReplayed: 0 };
  let failingSeed: number | null = null;

  for (let seed = 1; seed <= opts.seeds; seed++) {
    const s = runSession(seed, opts.steps, opts.devices, apply);
    INVARIANTS.forEach((inv, i) => {
      const detail = inv.check(s);
      if (detail === null || failures[i] !== null) return;
      failures[i] = `seed ${seed}: ${detail}`;
      failingSeed ??= seed;
    });
    counts.ops += s.submitted.length;
    counts.conflictsOpened += s.server.conflicts.length;
    counts.duplicatesReplayed += s.stats.duplicatesReplayed;
  }

  const invariants = INVARIANTS.map((inv, i) => ({
    name: inv.name,
    pass: failures[i] === null,
    detail: failures[i] ?? `held in all ${opts.seeds} seeds`,
  }));
  return {
    pass: invariants.every((r) => r.pass),
    invariants,
    failingSeed,
    elapsedMs: performance.now() - t0,
    seeds: opts.seeds,
    steps: opts.steps,
    devices: opts.devices,
    counts,
  };
}

function lostEdits(s: Session): number {
  return s.stats.silentOverwrites.length + s.stats.silentDrops.length + s.stats.unseenDeletes.length;
}

/** Runs the same seeded sessions with SyncTrail's merge and with the naive LWW harness. */
export function compareWithLastWriteWins(opts: Omit<SimulationOptions, 'apply'>): LwwComparison {
  const t0 = performance.now();
  const syncTrail: LostEditTotals = { ops: 0, lostEdits: 0 };
  const lastWriteWins: LostEditTotals = { ops: 0, lostEdits: 0 };
  for (let seed = 1; seed <= opts.seeds; seed++) {
    const ours = runSession(seed, opts.steps, opts.devices, applyOp);
    const lww = runSession(seed, opts.steps, opts.devices, lastWriteWinsApply);
    syncTrail.ops += ours.submitted.length;
    syncTrail.lostEdits += lostEdits(ours);
    lastWriteWins.ops += lww.submitted.length;
    lastWriteWins.lostEdits += lostEdits(lww);
  }
  return { sessions: opts.seeds, syncTrail, lastWriteWins, elapsedMs: performance.now() - t0 };
}
