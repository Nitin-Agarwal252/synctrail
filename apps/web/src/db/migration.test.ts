import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { SyncTrailDb } from './index';
import { hlc } from '@synctrail/shared';

describe('Dexie v1 -> v2 upgrade', () => {
  it('preserves existing outbox rows and adds an empty deadOps table', async () => {
    const name = `upgrade_${Math.random().toString(36).slice(2)}`;
    const v1 = new Dexie(name);
    v1.version(1).stores({
      snapshot: 'id, seq',
      outbox: '++n, opId, recordId',
      conflicts: 'id, recordId, status',
      opLog: '++n, opId',
      meta: 'key',
    });
    await v1.open();
    const rows = [1, 2, 3].map((i) => ({
      opId: `op_${i}`,
      deviceId: 'devA',
      userId: 'Meera',
      recordId: 'rec_1',
      type: i === 1 ? 'create' : 'set',
      field: i === 1 ? undefined : 'phone',
      value: i === 1 ? undefined : `p${i}`,
      fields: i === 1 ? { name: 'Rao' } : undefined,
      baseHlc: null,
      hlc: hlc.format({ wall: 1000 + i, counter: 0, node: 'devA' }),
    }));
    await v1.table('outbox').bulkAdd(rows);
    v1.close();

    const db = new SyncTrailDb(name);
    await db.open();
    expect(db.verno).toBe(2);
    const outbox = await db.outbox.orderBy('n').toArray();
    expect(outbox.map((o) => o.opId)).toEqual(['op_1', 'op_2', 'op_3']);
    expect(outbox[2].value).toBe('p3');
    expect(await db.deadOps.count()).toBe(0);
    db.close();
  });
});
