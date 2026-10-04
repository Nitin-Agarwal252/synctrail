import { describe, it, expect } from 'vitest';
import { applyOp, createServerState, previewOps, resolveConflict, seenOf } from './merge.ts';
import * as hlc from './hlc.ts';
import type { Op, ServerState } from './types.ts';

let n = 0;
const T = (ms: number, node = 'n') => hlc.format({ wall: ms, counter: 0, node });
function op(p: Partial<Op> & Pick<Op, 'type' | 'recordId' | 'deviceId' | 'hlc'>): Op {
  return { opId: `op${++n}`, userId: `u_${p.deviceId}`, baseHlc: null, ...p };
}
function seeded(): { s: ServerState; createHlc: string } {
  const s = createServerState();
  const createHlc = T(100);
  applyOp(s, op({ type: 'create', recordId: 'r1', deviceId: 'A', hlc: createHlc, fields: { name: 'Rao', phone: '111', status: 'new', notes: '' } }));
  return { s, createHlc };
}

describe('hlc', () => {
  it('orders by wall then counter and survives a slow clock', () => {
    const a = hlc.tick(null, 'x', 1000);
    const b = hlc.tick(a, 'x', 500);
    expect(hlc.compare(a, b)).toBe(-1);
    expect(hlc.parse(b).counter).toBe(1);
  });
  it('receive moves the clock past a remote timestamp', () => {
    const remote = hlc.format({ wall: 9000, counter: 3, node: 'r' });
    const local = hlc.receive(hlc.tick(null, 'l', 100), remote, 'l', 200);
    expect(hlc.compare(local, remote)).toBe(1);
  });
});

describe('merge engine', () => {
  it('is idempotent by opId', () => {
    const { s, createHlc } = seeded();
    const o = op({ type: 'set', recordId: 'r1', deviceId: 'A', hlc: T(200), field: 'phone', value: '222', baseHlc: createHlc });
    expect(applyOp(s, o).status).toBe('applied');
    expect(applyOp(s, o).status).toBe('duplicate');
    expect(s.records.r1.fields.phone.value).toBe('222');
  });

  it('merges edits to DIFFERENT fields with no conflict', () => {
    const { s, createHlc } = seeded();
    const a = op({ type: 'set', recordId: 'r1', deviceId: 'A', hlc: T(200), field: 'notes', value: 'second visit', baseHlc: createHlc });
    const b = op({ type: 'set', recordId: 'r1', deviceId: 'B', hlc: T(210), field: 'phone', value: '999', baseHlc: createHlc });
    expect(applyOp(s, a).status).toBe('applied');
    expect(applyOp(s, b).status).toBe('applied');
    expect(s.records.r1.fields.notes.value).toBe('second visit');
    expect(s.records.r1.fields.phone.value).toBe('999');
    expect(s.conflicts).toHaveLength(0);
  });

  it('opens a conflict for the SAME field and overwrites nothing', () => {
    const { s, createHlc } = seeded();
    const a = op({ type: 'set', recordId: 'r1', deviceId: 'A', hlc: T(200), field: 'status', value: 'follow-up', baseHlc: createHlc });
    const b = op({ type: 'set', recordId: 'r1', deviceId: 'B', hlc: T(210), field: 'status', value: 'completed', baseHlc: createHlc });
    applyOp(s, a);
    const r = applyOp(s, b);
    expect(r.status).toBe('conflict');
    expect(s.records.r1.fields.status.value).toBe('follow-up');
    expect(s.conflicts[0].baseValue).toBe('new');
    expect(s.conflicts[0].mine.value).toBe('completed');
    expect(s.conflicts[0].theirs.value).toBe('follow-up');
  });

  it('treats identical concurrent values as a no-op, not a conflict', () => {
    const { s, createHlc } = seeded();
    applyOp(s, op({ type: 'set', recordId: 'r1', deviceId: 'A', hlc: T(200), field: 'status', value: 'done', baseHlc: createHlc }));
    const r = applyOp(s, op({ type: 'set', recordId: 'r1', deviceId: 'B', hlc: T(210), field: 'status', value: 'done', baseHlc: createHlc }));
    expect(r.status).toBe('noop');
    expect(s.conflicts).toHaveLength(0);
  });

  it('applies a device\'s own sequential offline edits in order', () => {
    const { s, createHlc } = seeded();
    const e1 = op({ type: 'set', recordId: 'r1', deviceId: 'A', hlc: T(200), field: 'notes', value: 'v1', baseHlc: createHlc });
    const e2 = op({ type: 'set', recordId: 'r1', deviceId: 'A', hlc: T(210), field: 'notes', value: 'v2', baseHlc: e1.hlc });
    expect(applyOp(s, e1).status).toBe('applied');
    expect(applyOp(s, e2).status).toBe('applied');
    expect(s.records.r1.fields.notes.value).toBe('v2');
  });

  it('folds a follow-up edit into its own open conflict instead of opening a second', () => {
    const { s, createHlc } = seeded();
    applyOp(s, op({ type: 'set', recordId: 'r1', deviceId: 'A', hlc: T(200), field: 'status', value: 'x', baseHlc: createHlc }));
    const b1 = op({ type: 'set', recordId: 'r1', deviceId: 'B', hlc: T(210), field: 'status', value: 'y', baseHlc: createHlc });
    const b2 = op({ type: 'set', recordId: 'r1', deviceId: 'B', hlc: T(220), field: 'status', value: 'z', baseHlc: b1.hlc });
    applyOp(s, b1);
    applyOp(s, b2);
    expect(s.conflicts).toHaveLength(1);
    expect(s.conflicts[0].mine.value).toBe('z');
  });

  it('edit-vs-delete: editing a record someone deleted is a conflict and the work is kept', () => {
    const { s, createHlc } = seeded();
    applyOp(s, op({ type: 'delete', recordId: 'r1', deviceId: 'A', hlc: T(200), seen: seenOf(s.records.r1) }));
    const r = applyOp(s, op({ type: 'set', recordId: 'r1', deviceId: 'B', hlc: T(210), field: 'notes', value: 'important', baseHlc: createHlc }));
    expect(r.status).toBe('conflict');
    expect(s.conflicts[0].kind).toBe('edit-vs-delete');
    const ok = resolveConflict(s, s.conflicts[0].id, { choice: 'mine' }, { userId: 'u', deviceId: 'B', opId: 'res1', hlc: T(300) });
    expect(ok.ok).toBe(true);
    expect(s.records.r1.deleted).toBe(false);
    expect(s.records.r1.fields.notes.value).toBe('important');
  });

  it('delete-vs-edit: deleting a record someone else edited is a conflict', () => {
    const { s, createHlc } = seeded();
    const seen = seenOf(s.records.r1);
    applyOp(s, op({ type: 'set', recordId: 'r1', deviceId: 'A', hlc: T(200), field: 'notes', value: 'edited', baseHlc: createHlc }));
    const r = applyOp(s, op({ type: 'delete', recordId: 'r1', deviceId: 'B', hlc: T(210), seen }));
    expect(r.status).toBe('conflict');
    expect(s.records.r1.deleted).toBe(false);
    expect(s.conflicts[0].kind).toBe('delete-vs-edit');
    resolveConflict(s, s.conflicts[0].id, { choice: 'mine' }, { userId: 'u', deviceId: 'B', opId: 'res2', hlc: T(300) });
    expect(s.records.r1.deleted).toBe(true);
  });

  it('a delete after your own edit is NOT a conflict', () => {
    const { s, createHlc } = seeded();
    const e = op({ type: 'set', recordId: 'r1', deviceId: 'A', hlc: T(200), field: 'notes', value: 'mine', baseHlc: createHlc });
    applyOp(s, e);
    const seen = { ...seenOf(s.records.r1) };
    expect(applyOp(s, op({ type: 'delete', recordId: 'r1', deviceId: 'A', hlc: T(210), seen })).status).toBe('applied');
  });

  it('rejects ops for an unknown record WITHOUT marking them seen (retry-safe)', () => {
    const s = createServerState();
    const o = op({ type: 'set', recordId: 'ghost', deviceId: 'A', hlc: T(200), field: 'x', value: 1 });
    expect(applyOp(s, o).status).toBe('rejected');
    expect(s.seenOps.has(o.opId)).toBe(false);
    applyOp(s, op({ type: 'create', recordId: 'ghost', deviceId: 'A', hlc: T(100), fields: {} }));
    expect(applyOp(s, o).status).toBe('applied');
  });

  it('resolve: keep theirs leaves the server value, custom writes a new one, double-resolve is refused', () => {
    const { s, createHlc } = seeded();
    applyOp(s, op({ type: 'set', recordId: 'r1', deviceId: 'A', hlc: T(200), field: 'status', value: 'x', baseHlc: createHlc }));
    applyOp(s, op({ type: 'set', recordId: 'r1', deviceId: 'B', hlc: T(210), field: 'status', value: 'y', baseHlc: createHlc }));
    const id = s.conflicts[0].id;
    expect(resolveConflict(s, id, { choice: 'custom', value: 'merged' }, { userId: 'u', deviceId: 'B', opId: 'res3', hlc: T(300) }).ok).toBe(true);
    expect(s.records.r1.fields.status.value).toBe('merged');
    expect(resolveConflict(s, id, { choice: 'theirs' }, { userId: 'u', deviceId: 'B', opId: 'res4', hlc: T(310) }).reason).toBe('already-resolved');
  });

  it('previewOps predicts outcomes without touching real state', () => {
    const { s, createHlc } = seeded();
    applyOp(s, op({ type: 'set', recordId: 'r1', deviceId: 'A', hlc: T(200), field: 'status', value: 'x', baseHlc: createHlc }));
    const before = JSON.stringify([s.records, s.conflicts, s.log.length]);
    const res = previewOps(s, [
      op({ type: 'set', recordId: 'r1', deviceId: 'B', hlc: T(210), field: 'phone', value: '5', baseHlc: createHlc }),
      op({ type: 'set', recordId: 'r1', deviceId: 'B', hlc: T(211), field: 'status', value: 'y', baseHlc: createHlc }),
    ]);
    expect(res.map((r) => r.status)).toEqual(['applied', 'conflict']);
    expect(JSON.stringify([s.records, s.conflicts, s.log.length])).toBe(before);
  });
});
