import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { SyncTrailDb } from './index';
import { hlc } from '@synctrail/shared';

describe('Client Storage & Outbox (SyncTrailDb)', () => {
  let db: SyncTrailDb;

  beforeEach(async () => {
    // Unique DB name per test to ensure isolated IndexedDB instances
    db = new SyncTrailDb(`test_db_${Math.random().toString(36).slice(2)}`);
  });

  it('initializes metadata with default deviceId and userId (Meera)', async () => {
    const meta = await db.initMeta();
    expect(meta.deviceId).toMatch(/^dev_/);
    expect(meta.userId).toBe('Meera');

    const storedDeviceId = await db.getMeta('deviceId');
    const storedUserId = await db.getMeta('userId');
    expect(storedDeviceId).toBe(meta.deviceId);
    expect(storedUserId).toBe('Meera');
  });

  it('updates metadata when switching user', async () => {
    await db.initMeta();
    await db.setMeta('userId', 'Dev');
    const user = await db.getMeta('userId');
    expect(user).toBe('Dev');
  });

  it('ticks HLC monotonically', async () => {
    const { deviceId } = await db.initMeta();
    const hlc1 = await db.tickClock(deviceId);
    const hlc2 = await db.tickClock(deviceId);

    expect(hlc1 < hlc2).toBe(true);
    const parsed1 = hlc.parse(hlc1);
    const parsed2 = hlc.parse(hlc2);
    expect(parsed1.node).toBe(deviceId);
    expect(parsed2.node).toBe(deviceId);
  });

  it('creates household op with baseHlc null and all initial fields', async () => {
    const recordId = await db.createHousehold({
      name: 'Rao family',
      phone: '98300 11122',
      address: '14 North Cross Road',
      status: 'new',
      notes: 'Initial survey',
    });

    expect(recordId).toMatch(/^rec_/);

    const outboxOps = await db.outbox.toArray();
    expect(outboxOps).toHaveLength(1);
    const op = outboxOps[0];

    expect(op.type).toBe('create');
    expect(op.recordId).toBe(recordId);
    expect(op.baseHlc).toBeNull();
    expect(op.userId).toBe('Meera');
    expect(op.fields).toEqual({
      name: 'Rao family',
      phone: '98300 11122',
      address: '14 North Cross Road',
      status: 'new',
      notes: 'Initial survey',
    });

    const opLog = await db.opLog.toArray();
    expect(opLog).toHaveLength(1);
    expect(opLog[0].opId).toBe(op.opId);
    expect(opLog[0].type).toBe('create');
  });

  it('derives view for a locally created household', async () => {
    const recordId = await db.createHousehold({
      name: 'Gupta family',
      phone: '98111 22233',
      address: 'Lane 4',
      status: 'follow-up',
      notes: 'Needs callback',
    });

    const view = await db.deriveViewForRecord(recordId);
    expect(view).toBeDefined();
    expect(view?.id).toBe(recordId);
    expect(view?.deleted).toBe(false);
    expect(view?.fields.name?.value).toBe('Gupta family');
    expect(view?.fields.status?.value).toBe('follow-up');
    expect(view?.fields.notes?.value).toBe('Needs callback');
  });

  it('updates field: populates baseHlc from previous field HLC', async () => {
    const recordId = await db.createHousehold({
      name: 'Patel family',
      phone: '98222 33344',
      address: 'Sector 5',
      status: 'new',
      notes: '',
    });

    const initialView = await db.deriveViewForRecord(recordId);
    const initialStatusHlc = initialView?.fields.status?.hlc;
    expect(initialStatusHlc).toBeDefined();

    // Now update status field
    await db.updateField(recordId, 'status', 'follow-up');

    const outboxOps = await db.outbox.toArray();
    expect(outboxOps).toHaveLength(2);
    const setOp = outboxOps[1];

    expect(setOp.type).toBe('set');
    expect(setOp.field).toBe('status');
    expect(setOp.value).toBe('follow-up');
    expect(setOp.baseHlc).toBe(initialStatusHlc);

    const updatedView = await db.deriveViewForRecord(recordId);
    expect(updatedView?.fields.status?.value).toBe('follow-up');
    expect(updatedView?.fields.status?.hlc).toBe(setOp.hlc);
  });

  it('ignores no-op updateField when value is identical to current view', async () => {
    const recordId = await db.createHousehold({
      name: 'Sharma',
      phone: '123',
      address: 'Main St',
      status: 'new',
      notes: '',
    });

    // Try setting status to same value 'new'
    await db.updateField(recordId, 'status', 'new');

    const outboxOps = await db.outbox.toArray();
    expect(outboxOps).toHaveLength(1); // Still only create op
  });

  it('deletes household: records seen mapping of all field HLCs', async () => {
    const recordId = await db.createHousehold({
      name: 'Verma family',
      phone: '98765 43210',
      address: 'Block C',
      status: 'completed',
      notes: 'All done',
    });

    const viewBeforeDelete = await db.deriveViewForRecord(recordId);
    expect(viewBeforeDelete).toBeDefined();

    await db.deleteHousehold(recordId);

    const outboxOps = await db.outbox.toArray();
    expect(outboxOps).toHaveLength(2);
    const deleteOp = outboxOps[1];

    expect(deleteOp.type).toBe('delete');
    expect(deleteOp.recordId).toBe(recordId);
    expect(deleteOp.seen).toBeDefined();
    expect(deleteOp.seen?.name).toBe(viewBeforeDelete?.fields.name?.hlc);
    expect(deleteOp.seen?.phone).toBe(viewBeforeDelete?.fields.phone?.hlc);
    expect(deleteOp.seen?.status).toBe(viewBeforeDelete?.fields.status?.hlc);

    const viewAfterDelete = await db.deriveViewForRecord(recordId);
    expect(viewAfterDelete?.deleted).toBe(true);
    expect(viewAfterDelete?.deletedHlc).toBe(deleteOp.hlc);
  });

  it('restores deleted household', async () => {
    const recordId = await db.createHousehold({
      name: 'Khan family',
      phone: '98000 00000',
      address: 'Hill road',
      status: 'new',
      notes: '',
    });

    await db.deleteHousehold(recordId);
    const viewDeleted = await db.deriveViewForRecord(recordId);
    expect(viewDeleted?.deleted).toBe(true);

    await db.restoreHousehold(recordId);
    const viewRestored = await db.deriveViewForRecord(recordId);
    expect(viewRestored?.deleted).toBe(false);
    expect(viewRestored?.fields.name?.value).toBe('Khan family');
  });

  it('derives all views combining snapshots and outbox ops correctly', async () => {
    // Seed snapshot as if received from server
    await db.snapshot.put({
      id: 'rec_server_1',
      fields: {
        name: {
          value: 'Server Family',
          hlc: '2026-10-04T08:00:00.000Z-0000-dev_srv',
          opId: 'op_srv_1',
          deviceId: 'dev_srv',
          userId: 'Arjun',
        },
        phone: {
          value: '111222',
          hlc: '2026-10-04T08:00:00.000Z-0000-dev_srv',
          opId: 'op_srv_1',
          deviceId: 'dev_srv',
          userId: 'Arjun',
        },
      },
      deleted: false,
      deletedHlc: null,
      deletedBy: null,
      version: '2026-10-04T08:00:00.000Z-0000-dev_srv',
      seq: 1,
    });

    // Also create a local record
    const localId = await db.createHousehold({
      name: 'Local Family',
      phone: '333444',
      address: 'Local street',
      status: 'new',
      notes: '',
    });

    // And modify the server record locally
    await db.updateField('rec_server_1', 'phone', '999888');

    const allViews = await db.deriveAllViews();
    expect(Object.keys(allViews)).toHaveLength(2);

    expect(allViews['rec_server_1'].fields.name.value).toBe('Server Family');
    expect(allViews['rec_server_1'].fields.phone.value).toBe('999888');
    expect(allViews[localId].fields.name.value).toBe('Local Family');
  });
});
