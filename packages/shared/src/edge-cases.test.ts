import { describe, it, expect } from 'vitest';
import { applyOp, createServerState, resolveConflict, seenOf } from './merge.ts';
import * as hlc from './hlc.ts';
import type { Op, ServerState } from './types.ts';

let opCounter = 0;
const formatHlc = (wall: number, node = 'test-node') => hlc.format({ wall, counter: 0, node });

function makeOp(p: Partial<Op> & Pick<Op, 'type' | 'recordId' | 'deviceId' | 'hlc'>): Op {
  return {
    opId: `edge_op_${++opCounter}`,
    userId: `user_${p.deviceId}`,
    baseHlc: null,
    ...p,
  };
}

describe('Testing Plan Edge Cases (#4, #6, #7, #8, #9)', () => {
  // Edge Case #4: Out-of-order: set arrives before create
  it('Edge Case #4: set arriving before create is rejected, not marked seen, and succeeds on retry', () => {
    const s: ServerState = createServerState();
    const createHlc = formatHlc(100, 'dev_A');

    // Device A created record; Device B saw it and edited phone.
    // Due to network reordering, Device B's set arrives at the server BEFORE Device A's create arrives.
    const setOp = makeOp({
      type: 'set',
      recordId: 'rec_ooo',
      deviceId: 'dev_B',
      field: 'phone',
      value: '555-0199',
      baseHlc: createHlc,
      hlc: formatHlc(200, 'dev_B'),
    });

    // 1. set arrives before create -> rejected because record is unknown
    const rejectRes = applyOp(s, setOp);
    expect(rejectRes.status).toBe('rejected');
    expect(rejectRes.reason).toBe('unknown-record');
    expect(s.seenOps.has(setOp.opId)).toBe(false);

    // 2. create arrives -> applied
    const createOp = makeOp({
      type: 'create',
      recordId: 'rec_ooo',
      deviceId: 'dev_A',
      hlc: createHlc,
      fields: { name: 'Hospital', phone: '000' },
    });
    const createRes = applyOp(s, createOp);
    expect(createRes.status).toBe('applied');

    // 3. set retried after create landed -> now applied cleanly
    const retryRes = applyOp(s, setOp);
    expect(retryRes.status).toBe('applied');
    expect(s.records.rec_ooo.fields.phone.value).toBe('555-0199');
    expect(s.seenOps.has(setOp.opId)).toBe(true);
  });

  // Edge Case #6: Same field, same value from two devices (no-op)
  it('Edge Case #6: same field set to same value by two concurrent devices is a no-op with no conflict', () => {
    const s: ServerState = createServerState();
    const createHlc = formatHlc(100, 'dev_init');
    applyOp(
      s,
      makeOp({
        type: 'create',
        recordId: 'rec_eq',
        deviceId: 'dev_init',
        hlc: createHlc,
        fields: { status: 'new' },
      }),
    );

    const opA = makeOp({
      type: 'set',
      recordId: 'rec_eq',
      deviceId: 'dev_A',
      field: 'status',
      value: 'completed',
      baseHlc: createHlc,
      hlc: formatHlc(200, 'dev_A'),
    });

    const opB = makeOp({
      type: 'set',
      recordId: 'rec_eq',
      deviceId: 'dev_B',
      field: 'status',
      value: 'completed',
      baseHlc: createHlc,
      hlc: formatHlc(210, 'dev_B'),
    });

    expect(applyOp(s, opA).status).toBe('applied');
    const resB = applyOp(s, opB);
    expect(resB.status).toBe('noop');
    expect(s.conflicts).toHaveLength(0);
    expect(s.records.rec_eq.fields.status.value).toBe('completed');
  });

  // Edge Case #7: Clock skew and 1970 epoch clock (correctness independent of clocks)
  it('Edge Case #7: a device with a 1970 clock edits and syncs with others with no lost edit and no silent overwrite', () => {
    const s: ServerState = createServerState();
    const MODERN_TIME = 1_770_000_000_000; // 2026 timestamp
    const EPOCH_1970 = 100; // device stuck in 1970 (100ms after Unix epoch)

    // Device A creates record in 2026
    let clockA: string | null = hlc.tick(null, 'dev_A', MODERN_TIME);
    const createHlc = clockA;
    applyOp(
      s,
      makeOp({
        type: 'create',
        recordId: 'rec_skew',
        deviceId: 'dev_A',
        hlc: createHlc,
        fields: { name: 'Health Clinic', phone: '111', status: 'new' },
      }),
    );

    // Device B has clock stuck at 1970 epoch
    let clockB: string | null = null;
    // Device B pulls and syncs with server, receiving Device A's record version into its HLC
    clockB = hlc.receive(clockB, s.records.rec_skew.version, 'dev_B', EPOCH_1970);
    // HLC guarantees clockB wall segment >= clockA wall segment
    expect(hlc.compare(clockB, createHlc)).toBeGreaterThan(0);

    // Device B edits phone while its physical clock is still in 1970
    clockB = hlc.tick(clockB, 'dev_B', EPOCH_1970);
    const opBPhone = makeOp({
      type: 'set',
      recordId: 'rec_skew',
      deviceId: 'dev_B',
      field: 'phone',
      value: '999-1970',
      baseHlc: s.records.rec_skew.fields.phone.hlc,
      hlc: clockB,
    });

    // Device A concurrently edits notes
    clockA = hlc.tick(clockA, 'dev_A', MODERN_TIME + 5000);
    const opANotes = makeOp({
      type: 'set',
      recordId: 'rec_skew',
      deviceId: 'dev_A',
      field: 'notes',
      value: 'Regular visit',
      baseHlc: s.records.rec_skew.fields.notes?.hlc ?? null,
      hlc: clockA,
    });

    // Both ops apply cleanly regardless of the 1970 physical clock
    expect(applyOp(s, opBPhone).status).toBe('applied');
    expect(applyOp(s, opANotes).status).toBe('applied');

    expect(s.records.rec_skew.fields.phone.value).toBe('999-1970');
    expect(s.records.rec_skew.fields.notes.value).toBe('Regular visit');
    expect(s.conflicts).toHaveLength(0);

    // Now test concurrent conflict with 1970 clock:
    // Device B (1970 clock) and Device A (2026 clock) both edit 'status' from 'new'
    clockB = hlc.tick(clockB, 'dev_B', EPOCH_1970);
    const opBConflict = makeOp({
      type: 'set',
      recordId: 'rec_skew',
      deviceId: 'dev_B',
      field: 'status',
      value: 'completed',
      baseHlc: createHlc,
      hlc: clockB,
    });

    clockA = hlc.tick(clockA, 'dev_A', MODERN_TIME + 10000);
    const opAConflict = makeOp({
      type: 'set',
      recordId: 'rec_skew',
      deviceId: 'dev_A',
      field: 'status',
      value: 'follow-up',
      baseHlc: createHlc,
      hlc: clockA,
    });

    // Apply Device A first
    expect(applyOp(s, opAConflict).status).toBe('applied');
    // Device B with 1970 clock must open a conflict, NEVER silently overwrite
    const resBConflict = applyOp(s, opBConflict);
    expect(resBConflict.status).toBe('conflict');
    expect(s.conflicts).toHaveLength(1);
    expect(s.conflicts[0].mine.value).toBe('completed');
    expect(s.conflicts[0].theirs.value).toBe('follow-up');
    expect(s.conflicts[0].baseValue).toBe('new');
    expect(s.records.rec_skew.fields.status.value).toBe('follow-up'); // not overwritten
  });

  // Edge Case #8: Chained offline edits on a conflicted field
  it('Edge Case #8: chained offline edits fold into a single open conflict preserving latest offline intent', () => {
    const s: ServerState = createServerState();
    const createHlc = formatHlc(100, 'dev_init');
    applyOp(
      s,
      makeOp({
        type: 'create',
        recordId: 'rec_chain',
        deviceId: 'dev_init',
        hlc: createHlc,
        fields: { status: 'new' },
      }),
    );

    // Remote device sets status to 'remote-val'
    applyOp(
      s,
      makeOp({
        type: 'set',
        recordId: 'rec_chain',
        deviceId: 'dev_remote',
        field: 'status',
        value: 'remote-val',
        baseHlc: createHlc,
        hlc: formatHlc(150, 'dev_remote'),
      }),
    );

    // Local device B makes a 3-edit offline chain on status:
    const e1 = makeOp({
      type: 'set',
      recordId: 'rec_chain',
      deviceId: 'dev_B',
      field: 'status',
      value: 'step-1',
      baseHlc: createHlc,
      hlc: formatHlc(200, 'dev_B'),
    });
    const e2 = makeOp({
      type: 'set',
      recordId: 'rec_chain',
      deviceId: 'dev_B',
      field: 'status',
      value: 'step-2',
      baseHlc: e1.hlc,
      hlc: formatHlc(210, 'dev_B'),
    });
    const e3 = makeOp({
      type: 'set',
      recordId: 'rec_chain',
      deviceId: 'dev_B',
      field: 'status',
      value: 'step-3',
      baseHlc: e2.hlc,
      hlc: formatHlc(220, 'dev_B'),
    });

    // First edit opens the conflict
    const r1 = applyOp(s, e1);
    expect(r1.status).toBe('conflict');
    expect(s.conflicts).toHaveLength(1);
    expect(s.conflicts[0].mine.value).toBe('step-1');

    // Second edit folds into open conflict
    const r2 = applyOp(s, e2);
    expect(r2.status).toBe('conflict');
    expect(s.conflicts).toHaveLength(1);
    expect(s.conflicts[0].mine.value).toBe('step-2');

    // Third edit folds into open conflict
    const r3 = applyOp(s, e3);
    expect(r3.status).toBe('conflict');
    expect(s.conflicts).toHaveLength(1);
    expect(s.conflicts[0].mine.value).toBe('step-3');

    // Resolving with 'mine' applies the final chained offline intent ('step-3')
    const resolveRes = resolveConflict(
      s,
      s.conflicts[0].id,
      { choice: 'mine' },
      { userId: 'user_B', deviceId: 'dev_B', opId: 'res_chain', hlc: formatHlc(300, 'dev_B') },
    );
    expect(resolveRes.ok).toBe(true);
    expect(s.records.rec_chain.fields.status.value).toBe('step-3');
  });

  // Edge Case #9: Double resolve of one conflict is refused across choices
  it('Edge Case #9: double resolve of a conflict is refused and does not alter resolved state', () => {
    const s: ServerState = createServerState();
    const createHlc = formatHlc(100);
    applyOp(
      s,
      makeOp({
        type: 'create',
        recordId: 'rec_dbl',
        deviceId: 'dev_A',
        hlc: createHlc,
        fields: { status: 'new' },
      }),
    );

    applyOp(
      s,
      makeOp({
        type: 'set',
        recordId: 'rec_dbl',
        deviceId: 'dev_A',
        field: 'status',
        value: 'val_A',
        baseHlc: createHlc,
        hlc: formatHlc(150, 'dev_A'),
      }),
    );

    applyOp(
      s,
      makeOp({
        type: 'set',
        recordId: 'rec_dbl',
        deviceId: 'dev_B',
        field: 'status',
        value: 'val_B',
        baseHlc: createHlc,
        hlc: formatHlc(160, 'dev_B'),
      }),
    );

    expect(s.conflicts).toHaveLength(1);
    const conflictId = s.conflicts[0].id;

    // First resolve succeeds
    const res1 = resolveConflict(
      s,
      conflictId,
      { choice: 'theirs' },
      { userId: 'u', deviceId: 'dev_admin', opId: 'res_1', hlc: formatHlc(200) },
    );
    expect(res1.ok).toBe(true);
    expect(s.records.rec_dbl.fields.status.value).toBe('val_A');

    // Second resolve with 'mine' is refused
    const res2 = resolveConflict(
      s,
      conflictId,
      { choice: 'mine' },
      { userId: 'u', deviceId: 'dev_admin', opId: 'res_2', hlc: formatHlc(210) },
    );
    expect(res2.ok).toBe(false);
    expect(res2.reason).toBe('already-resolved');
    expect(s.records.rec_dbl.fields.status.value).toBe('val_A'); // unchanged

    // Third resolve with 'custom' is refused
    const res3 = resolveConflict(
      s,
      conflictId,
      { choice: 'custom', value: 'tampered' },
      { userId: 'u', deviceId: 'dev_admin', opId: 'res_3', hlc: formatHlc(220) },
    );
    expect(res3.ok).toBe(false);
    expect(res3.reason).toBe('already-resolved');
    expect(s.records.rec_dbl.fields.status.value).toBe('val_A'); // unchanged
  });

  // Edge Case #5: Edit-vs-delete and delete-vs-edit in both orders
  it('Edge Case #5: edit-vs-delete and delete-vs-edit in both orders open conflict and preserve data', () => {
    // Part A: Delete arrives first, then Edit arrives (edit-vs-delete)
    const sA = createServerState();
    const createHlcA = formatHlc(100, 'dev_init');
    applyOp(
      sA,
      makeOp({
        type: 'create',
        recordId: 'rec_evd',
        deviceId: 'dev_init',
        hlc: createHlcA,
        fields: { name: 'Alpha', notes: 'original' },
      }),
    );

    const delOp = makeOp({
      type: 'delete',
      recordId: 'rec_evd',
      deviceId: 'dev_del',
      hlc: formatHlc(150, 'dev_del'),
      seen: seenOf(sA.records.rec_evd),
    });
    expect(applyOp(sA, delOp).status).toBe('applied');
    expect(sA.records.rec_evd.deleted).toBe(true);

    const editOp = makeOp({
      type: 'set',
      recordId: 'rec_evd',
      deviceId: 'dev_edit',
      field: 'notes',
      value: 'offline edit while other deleted',
      baseHlc: createHlcA,
      hlc: formatHlc(160, 'dev_edit'),
    });
    const editRes = applyOp(sA, editOp);
    expect(editRes.status).toBe('conflict');
    expect(sA.conflicts).toHaveLength(1);
    expect(sA.conflicts[0].kind).toBe('edit-vs-delete');

    // Part B: Edit arrives first, then Delete arrives with outdated seen snapshot (delete-vs-edit)
    const sB = createServerState();
    const createHlcB = formatHlc(100, 'dev_init');
    applyOp(
      sB,
      makeOp({
        type: 'create',
        recordId: 'rec_dve',
        deviceId: 'dev_init',
        hlc: createHlcB,
        fields: { name: 'Beta', notes: 'v1' },
      }),
    );
    const seenBeforeEdit = seenOf(sB.records.rec_dve);

    // Concurrent edit arrives first
    const remoteEdit = makeOp({
      type: 'set',
      recordId: 'rec_dve',
      deviceId: 'dev_other',
      field: 'notes',
      value: 'v2 remote',
      baseHlc: createHlcB,
      hlc: formatHlc(150, 'dev_other'),
    });
    expect(applyOp(sB, remoteEdit).status).toBe('applied');

    // Delete arrives with snapshot that did not see v2 remote
    const staleDelete = makeOp({
      type: 'delete',
      recordId: 'rec_dve',
      deviceId: 'dev_stale_del',
      hlc: formatHlc(160, 'dev_stale_del'),
      seen: seenBeforeEdit,
    });
    const delRes = applyOp(sB, staleDelete);
    expect(delRes.status).toBe('conflict');
    expect(sB.conflicts).toHaveLength(1);
    expect(sB.conflicts[0].kind).toBe('delete-vs-edit');
    expect(sB.records.rec_dve.deleted).toBe(false); // record NOT silently destroyed
  });
});
