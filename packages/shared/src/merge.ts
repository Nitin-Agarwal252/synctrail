import { max } from './hlc.ts';
import type {
  ApplyResult,
  AuditEntry,
  Conflict,
  FieldValue,
  Hlc,
  Op,
  RecordState,
  ResolveChoice,
  ServerState,
} from './types.ts';

/**
 * RULES (the whole product hinges on these):
 *  1. Ops are immutable and idempotent by opId.
 *  2. A `set` applies only if the field has not changed since the author saw it
 *     (cur.hlc === op.baseHlc). Otherwise it becomes a Conflict. Nothing is overwritten.
 *  3. Different fields on the same record never conflict.
 *  4. Setting a field to the value it already has is a no-op, not a conflict.
 *  5. Deletes are tombstones. Edit-vs-delete in either order is a Conflict.
 *  6. Correctness never depends on wall clocks. HLC is for ordering display only.
 * This module is pure: no I/O, no Date.now(), no randomness. Keep it that way.
 */

export function createServerState(): ServerState {
  return { records: {}, log: [], seenOps: new Set(), conflicts: [], audit: [] };
}

function audit(state: ServerState, e: AuditEntry): void {
  state.audit.push(e);
}

function accept(state: ServerState, op: Op): void {
  state.seenOps.add(op.opId);
  state.log.push(op);
}

function writeField(
  rec: RecordState,
  field: string,
  value: FieldValue,
  hlc: Hlc,
  opId: string,
  deviceId: string,
  userId: string,
): void {
  rec.fields[field] = { value, hlc, opId, deviceId, userId };
  rec.version = max(rec.version, hlc);
}

function findBaseValue(
  state: ServerState,
  recordId: string,
  field: string,
  baseHlc: Hlc | null,
): FieldValue | undefined {
  if (!baseHlc) return undefined;
  for (let i = state.log.length - 1; i >= 0; i--) {
    const o = state.log[i];
    if (o.recordId !== recordId || o.hlc !== baseHlc) continue;
    if (o.type === 'set' && o.field === field) return o.value;
    if (o.type === 'create' && o.fields && field in o.fields) return o.fields[field];
  }
  return undefined;
}

function openConflict(
  state: ServerState,
  op: Op,
  rec: RecordState,
  kind: Conflict['kind'],
  field: string | null,
  theirsOverride?: Conflict['theirs'],
): ApplyResult {
  let theirs: Conflict['theirs'];
  if (theirsOverride) {
    theirs = theirsOverride;
  } else if (kind === 'edit-vs-delete') {
    theirs = {
      value: undefined,
      hlc: rec.deletedHlc ?? rec.version,
      deviceId: rec.deletedBy?.deviceId ?? 'unknown',
      userId: rec.deletedBy?.userId ?? 'unknown',
    };
  } else {
    const cur = rec.fields[field as string];
    theirs = { value: cur?.value, hlc: cur?.hlc ?? rec.version, deviceId: cur?.deviceId ?? 'unknown', userId: cur?.userId ?? 'unknown' };
  }
  const c: Conflict = {
    id: `c_${state.conflicts.length + 1}`,
    recordId: rec.id,
    kind,
    field,
    baseValue: field ? findBaseValue(state, rec.id, field, op.baseHlc) : undefined,
    theirs,
    mine: op,
    status: 'open',
  };
  state.conflicts.push(c);
  audit(state, { at: op.hlc, kind: 'conflict-opened', opId: op.opId, conflictId: c.id, recordId: rec.id, userId: op.userId, detail: kind });
  return { opId: op.opId, status: 'conflict', conflictId: c.id };
}

export function applyOp(state: ServerState, op: Op): ApplyResult {
  if (state.seenOps.has(op.opId)) return { opId: op.opId, status: 'duplicate' };

  const rec = state.records[op.recordId];

  // Out-of-order delivery: do NOT mark as seen, so the client can retry after the create lands.
  if (op.type !== 'create' && !rec) return { opId: op.opId, status: 'rejected', reason: 'unknown-record' };
  if (op.type === 'set' && !op.field) return { opId: op.opId, status: 'rejected', reason: 'missing-field' };

  accept(state, op);
  const done = (status: 'applied' | 'noop'): ApplyResult => {
    audit(state, { at: op.hlc, kind: status === 'applied' ? 'op-applied' : 'op-noop', opId: op.opId, recordId: op.recordId, userId: op.userId, detail: op.type });
    return { opId: op.opId, status };
  };

  switch (op.type) {
    case 'create': {
      if (rec) return done('noop');
      const r: RecordState = { id: op.recordId, fields: {}, deleted: false, deletedHlc: null, deletedBy: null, version: op.hlc };
      for (const [f, v] of Object.entries(op.fields ?? {})) writeField(r, f, v, op.hlc, op.opId, op.deviceId, op.userId);
      state.records[op.recordId] = r;
      return done('applied');
    }

    case 'set': {
      const field = op.field as string;
      const value = op.value as FieldValue;

      // Chain folding: a later edit by the same device on top of its own conflicted edit
      // updates that open conflict instead of creating a second one.
      const open = state.conflicts.find(
        (c) =>
          c.status === 'open' &&
          c.recordId === rec.id &&
          c.field === field &&
          c.mine.deviceId === op.deviceId &&
          c.mine.hlc === op.baseHlc,
      );
      if (open) {
        open.mine = op;
        audit(state, { at: op.hlc, kind: 'conflict-opened', opId: op.opId, conflictId: open.id, recordId: rec.id, userId: op.userId, detail: 'chained' });
        return { opId: op.opId, status: 'conflict', conflictId: open.id };
      }

      if (rec.deleted) return openConflict(state, op, rec, 'edit-vs-delete', field);

      const cur = rec.fields[field];
      if (cur && cur.value === value) return done('noop');
      if (!cur || cur.hlc === op.baseHlc) {
        writeField(rec, field, value, op.hlc, op.opId, op.deviceId, op.userId);
        return done('applied');
      }
      return openConflict(state, op, rec, 'field', field);
    }

    case 'delete': {
      if (rec.deleted) return done('noop');
      const seen = op.seen ?? {};
      let latest: { field: string; hlc: Hlc; value: FieldValue; deviceId: string; userId: string } | null = null;
      for (const [f, fs] of Object.entries(rec.fields)) {
        const known = seen[f] === fs.hlc;
        const mine = fs.deviceId === op.deviceId;
        if (!known && !mine) {
          if (!latest || fs.hlc > latest.hlc) latest = { field: f, hlc: fs.hlc, value: fs.value, deviceId: fs.deviceId, userId: fs.userId };
        }
      }
      if (latest) {
        return openConflict(state, op, rec, 'delete-vs-edit', null, { value: latest.value, hlc: latest.hlc, deviceId: latest.deviceId, userId: latest.userId });
      }
      rec.deleted = true;
      rec.deletedHlc = op.hlc;
      rec.deletedBy = { deviceId: op.deviceId, userId: op.userId };
      rec.version = max(rec.version, op.hlc);
      return done('applied');
    }

    case 'restore': {
      if (!rec.deleted) return done('noop');
      rec.deleted = false;
      rec.deletedHlc = null;
      rec.deletedBy = null;
      rec.version = max(rec.version, op.hlc);
      return done('applied');
    }
  }
}

export interface Resolver {
  userId: string;
  deviceId: string;
  /** Unique id for the resolution. Must be a fresh HLC from the resolver's clock after pulling. */
  opId: string;
  hlc: Hlc;
}

export function resolveConflict(
  state: ServerState,
  conflictId: string,
  choice: ResolveChoice,
  by: Resolver,
): { ok: boolean; reason?: string } {
  const c = state.conflicts.find((x) => x.id === conflictId);
  if (!c) return { ok: false, reason: 'not-found' };
  if (c.status === 'resolved') return { ok: false, reason: 'already-resolved' };
  const rec = state.records[c.recordId];
  if (!rec) return { ok: false, reason: 'unknown-record' };

  const synth = (type: Op['type'], extra: Partial<Op>, suffix: string): void => {
    const o: Op = { opId: `${by.opId}:${suffix}`, deviceId: by.deviceId, userId: by.userId, recordId: rec.id, type, baseHlc: null, hlc: by.hlc, ...extra };
    state.seenOps.add(o.opId);
    state.log.push(o);
  };

  if (c.kind === 'delete-vs-edit') {
    if (choice.choice === 'custom') return { ok: false, reason: 'custom-not-allowed' };
    if (choice.choice === 'mine' && !rec.deleted) {
      rec.deleted = true;
      rec.deletedHlc = by.hlc;
      rec.deletedBy = { deviceId: by.deviceId, userId: by.userId };
      rec.version = max(rec.version, by.hlc);
      synth('delete', {}, 'd');
    }
  } else {
    const field = c.field as string;
    let value: FieldValue | undefined;
    if (choice.choice === 'mine') value = c.mine.value as FieldValue;
    else if (choice.choice === 'custom') value = choice.value;

    if (value !== undefined) {
      if (c.kind === 'edit-vs-delete' && rec.deleted) {
        rec.deleted = false;
        rec.deletedHlc = null;
        rec.deletedBy = null;
        rec.version = max(rec.version, by.hlc);
        synth('restore', {}, 'r');
      }
      writeField(rec, field, value, by.hlc, `${by.opId}:s`, by.deviceId, by.userId);
      synth('set', { field, value }, 's');
    }
  }

  c.status = 'resolved';
  c.resolution = {
    choice: choice.choice,
    value: choice.choice === 'custom' ? choice.value : undefined,
    byUserId: by.userId,
    hlc: by.hlc,
  };
  audit(state, { at: by.hlc, kind: 'conflict-resolved', conflictId: c.id, recordId: rec.id, userId: by.userId, detail: choice.choice });
  return { ok: true };
}

/** Dry run for the "Sync preview" screen. Never mutates `state`. */
export function previewOps(state: ServerState, ops: Op[]): ApplyResult[] {
  const copy = structuredClone(state);
  return ops.map((o) => applyOp(copy, o));
}

/* ---------- client helpers (shared so client and server agree on shapes) ---------- */

/** Snapshot of field -> hlc, attached to delete ops. */
export function seenOf(rec: RecordState): Record<string, Hlc> {
  const out: Record<string, Hlc> = {};
  for (const [f, fs] of Object.entries(rec.fields)) out[f] = fs.hlc;
  return out;
}

/** Unconditionally apply an op to a local copy (optimistic UI). Server remains the judge. */
export function applyOptimistic(rec: RecordState | undefined, op: Op): RecordState | undefined {
  if (op.type === 'create') {
    if (rec) return rec;
    const r: RecordState = { id: op.recordId, fields: {}, deleted: false, deletedHlc: null, deletedBy: null, version: op.hlc };
    for (const [f, v] of Object.entries(op.fields ?? {})) writeField(r, f, v, op.hlc, op.opId, op.deviceId, op.userId);
    return r;
  }
  if (!rec) return rec;
  const next = structuredClone(rec);
  if (op.type === 'set' && op.field) writeField(next, op.field, op.value as FieldValue, op.hlc, op.opId, op.deviceId, op.userId);
  if (op.type === 'delete') {
    next.deleted = true;
    next.deletedHlc = op.hlc;
    next.deletedBy = { deviceId: op.deviceId, userId: op.userId };
    next.version = max(next.version, op.hlc);
  }
  if (op.type === 'restore') {
    next.deleted = false;
    next.deletedHlc = null;
    next.deletedBy = null;
    next.version = max(next.version, op.hlc);
  }
  return next;
}
