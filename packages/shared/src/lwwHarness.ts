/**
 * COMPARISON HARNESS ONLY. A deliberately naive last-write-wins apply, used by the Chaos page to show
 * what SyncTrail's merge prevents. SyncTrail never syncs with this; merge.ts is the only merge logic.
 */
import type { ApplyResult, FieldState, FieldValue, Op, RecordState, ServerState } from './types.ts';

function stamp(op: Op, value: FieldValue): FieldState {
  return { value, hlc: op.hlc, opId: op.opId, deviceId: op.deviceId, userId: op.userId };
}

function bump(rec: RecordState, op: Op): void {
  if (op.hlc > rec.version) rec.version = op.hlc;
}

function lwwCreate(state: ServerState, op: Op): ApplyResult['status'] {
  if (state.records[op.recordId]) return 'noop';
  const fields: Record<string, FieldState> = {};
  for (const [f, v] of Object.entries(op.fields ?? {})) fields[f] = stamp(op, v);
  state.records[op.recordId] = { id: op.recordId, fields, deleted: false, deletedHlc: null, deletedBy: null, version: op.hlc };
  return 'applied';
}

/** The newest HLC wins the field; anything older, or any edit to a deleted record, is dropped. */
function lwwSet(rec: RecordState, op: Op): ApplyResult['status'] {
  const cur = rec.fields[op.field as string];
  if (rec.deleted || (cur && cur.hlc > op.hlc) || (cur && cur.value === op.value)) return 'noop';
  rec.fields[op.field as string] = stamp(op, op.value ?? null);
  bump(rec, op);
  return 'applied';
}

function lwwTombstone(rec: RecordState, op: Op): ApplyResult['status'] {
  const deleting = op.type === 'delete';
  if (rec.deleted === deleting) return 'noop';
  rec.deleted = deleting;
  rec.deletedHlc = deleting ? op.hlc : null;
  rec.deletedBy = deleting ? { deviceId: op.deviceId, userId: op.userId } : null;
  bump(rec, op);
  return 'applied';
}

export function lastWriteWinsApply(state: ServerState, op: Op): ApplyResult {
  if (state.seenOps.has(op.opId)) return { opId: op.opId, status: 'duplicate' };
  const rec = state.records[op.recordId];
  if (op.type !== 'create' && !rec) return { opId: op.opId, status: 'rejected', reason: 'unknown-record' };
  state.seenOps.add(op.opId);
  state.log.push(op);
  if (op.type === 'create') return { opId: op.opId, status: lwwCreate(state, op) };
  if (op.type === 'set') return { opId: op.opId, status: lwwSet(rec, op) };
  return { opId: op.opId, status: lwwTombstone(rec, op) };
}
