import { DatabaseInstance, newEpoch } from './db';
import {
  applyOp,
  previewOps,
  resolveConflict,
  createServerState,
  type ApplyResult,
  type Conflict,
  type Op,
  type RecordState,
  type ResolveChoice,
  type Resolver,
  type ServerState,
  type AuditEntry,
  hlc,
} from '@synctrail/shared';

export interface PullResult {
  records: (RecordState & { seq: number })[];
  conflicts: (Conflict & { seq: number })[];
  seq: number;
  epoch: string;
  reset: boolean;
}

export interface StatsResult {
  records: number;
  openConflicts: number;
  ops: number;
  lastSeq: number;
}

export class SyncRepo {
  constructor(private db: DatabaseInstance) {}

  getSeq(): number {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('seq') as
      | { value: string }
      | undefined;
    return row ? Number(row.value) : 0;
  }

  getEpoch(): string {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('epoch') as
      | { value: string }
      | undefined;
    return row ? row.value : '';
  }

  /** A client on another epoch gets full state (since=0) with reset:true. */
  pullForClient(sinceSeq: number, clientEpoch?: string): PullResult {
    const epoch = this.getEpoch();
    if (clientEpoch !== undefined && clientEpoch !== epoch) {
      return { ...this.pull(0), reset: true };
    }
    return this.pull(sinceSeq);
  }

  private incrementSeq(): number {
    const current = this.getSeq();
    const next = current + 1;
    this.db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(next), 'seq');
    return next;
  }

  loadServerState(): ServerState {
    const state = createServerState();

    // Load records
    const recordRows = this.db
      .prepare('SELECT id, fields_json, deleted, deleted_hlc, deleted_by_json, version FROM records')
      .all() as {
      id: string;
      fields_json: string;
      deleted: number;
      deleted_hlc: string | null;
      deleted_by_json: string | null;
      version: string;
    }[];

    for (const row of recordRows) {
      state.records[row.id] = {
        id: row.id,
        fields: JSON.parse(row.fields_json),
        deleted: Boolean(row.deleted),
        deletedHlc: row.deleted_hlc,
        deletedBy: row.deleted_by_json ? JSON.parse(row.deleted_by_json) : null,
        version: row.version,
      };
    }

    // Load ops
    const opRows = this.db.prepare('SELECT op_id, op_json FROM ops ORDER BY seq ASC').all() as {
      op_id: string;
      op_json: string;
    }[];

    for (const row of opRows) {
      state.seenOps.add(row.op_id);
      try {
        state.log.push(JSON.parse(row.op_json));
      } catch {
        // ignore malformed log entries
      }
    }

    // Load conflicts
    const conflictRows = this.db.prepare('SELECT json FROM conflicts').all() as { json: string }[];
    for (const row of conflictRows) {
      try {
        state.conflicts.push(JSON.parse(row.json));
      } catch {
        // ignore malformed conflict json
      }
    }

    // Load audit
    const auditRows = this.db
      .prepare('SELECT at, kind, record_id, user_id, op_id, conflict_id, detail FROM audit ORDER BY seq ASC')
      .all() as {
      at: string;
      kind: AuditEntry['kind'];
      record_id: string;
      user_id: string;
      op_id: string | null;
      conflict_id: string | null;
      detail: string | null;
    }[];

    for (const row of auditRows) {
      state.audit.push({
        at: row.at,
        kind: row.kind,
        recordId: row.record_id,
        userId: row.user_id,
        opId: row.op_id ?? undefined,
        conflictId: row.conflict_id ?? undefined,
        detail: row.detail ?? undefined,
      });
    }

    return state;
  }

  executePush(deviceId: string, userId: string, ops: Op[]): { results: ApplyResult[]; seq: number; changed: boolean } {
    const tx = this.db.transaction(() => {
      const state = this.loadServerState();
      const results: ApplyResult[] = [];
      const auditCountBefore = state.audit.length;
      let stateChanged = false;

      const insertOpStmt = this.db.prepare(`
        INSERT INTO ops (op_id, record_id, device_id, user_id, op_json, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      const upsertRecordStmt = this.db.prepare(`
        INSERT INTO records (id, fields_json, deleted, deleted_hlc, deleted_by_json, version, seq)
        VALUES (@id, @fields_json, @deleted, @deleted_hlc, @deleted_by_json, @version, @seq)
        ON CONFLICT(id) DO UPDATE SET
          fields_json = excluded.fields_json,
          deleted = excluded.deleted,
          deleted_hlc = excluded.deleted_hlc,
          deleted_by_json = excluded.deleted_by_json,
          version = excluded.version,
          seq = excluded.seq
      `);

      const upsertConflictStmt = this.db.prepare(`
        INSERT INTO conflicts (id, record_id, json, status, seq)
        VALUES (@id, @record_id, @json, @status, @seq)
        ON CONFLICT(id) DO UPDATE SET
          json = excluded.json,
          status = excluded.status,
          seq = excluded.seq
      `);

      const insertAuditStmt = this.db.prepare(`
        INSERT INTO audit (at, kind, record_id, user_id, op_id, conflict_id, detail)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const op of ops) {
        // Enforce incoming author credentials if not set
        const opWithDevice: Op = {
          ...op,
          deviceId: op.deviceId || deviceId,
          userId: op.userId || userId,
        };

        const res = applyOp(state, opWithDevice);
        results.push(res);

        // Record op into ops table if not rejected for missing/unknown
        if (res.status !== 'rejected') {
          // If already in seenOps, insert might fail if op_id is unique
          if (res.status !== 'duplicate') {
            insertOpStmt.run(
              opWithDevice.opId,
              opWithDevice.recordId,
              opWithDevice.deviceId,
              opWithDevice.userId,
              JSON.stringify(opWithDevice),
              res.status,
            );
          }
        }

        if (res.status === 'applied') {
          stateChanged = true;
          const currentSeq = this.incrementSeq();
          const rec = state.records[opWithDevice.recordId];
          if (rec) {
            upsertRecordStmt.run({
              id: rec.id,
              fields_json: JSON.stringify(rec.fields),
              deleted: rec.deleted ? 1 : 0,
              deleted_hlc: rec.deletedHlc,
              deleted_by_json: rec.deletedBy ? JSON.stringify(rec.deletedBy) : null,
              version: rec.version,
              seq: currentSeq,
            });
          }
        } else if (res.status === 'conflict') {
          stateChanged = true;
          const currentSeq = this.incrementSeq();
          const conflict = state.conflicts.find((c) => c.id === res.conflictId);
          if (conflict) {
            upsertConflictStmt.run({
              id: conflict.id,
              record_id: conflict.recordId,
              json: JSON.stringify(conflict),
              status: conflict.status,
              seq: currentSeq,
            });
          }
        }
      }

      // Persist any new audit entries created during push
      const newAudits = state.audit.slice(auditCountBefore);
      for (const a of newAudits) {
        insertAuditStmt.run(
          a.at,
          a.kind,
          a.recordId,
          a.userId,
          a.opId ?? null,
          a.conflictId ?? null,
          a.detail ?? null,
        );
      }

      return {
        results,
        seq: this.getSeq(),
        changed: stateChanged,
      };
    });

    return tx();
  }

  executePreview(ops: Op[]): { results: ApplyResult[] } {
    // Pure preview: loads server state, executes previewOps, NEVER mutates SQLite
    const state = this.loadServerState();
    const results = previewOps(state, ops);
    return { results };
  }

  pull(sinceSeq: number): PullResult {
    const currentSeq = this.getSeq();

    const recordRows = this.db
      .prepare(
        'SELECT id, fields_json, deleted, deleted_hlc, deleted_by_json, version, seq FROM records WHERE seq > ? ORDER BY seq ASC',
      )
      .all(sinceSeq) as {
      id: string;
      fields_json: string;
      deleted: number;
      deleted_hlc: string | null;
      deleted_by_json: string | null;
      version: string;
      seq: number;
    }[];

    const records: (RecordState & { seq: number })[] = recordRows.map((row) => ({
      id: row.id,
      fields: JSON.parse(row.fields_json),
      deleted: Boolean(row.deleted),
      deletedHlc: row.deleted_hlc,
      deletedBy: row.deleted_by_json ? JSON.parse(row.deleted_by_json) : null,
      version: row.version,
      seq: row.seq,
    }));

    const conflictRows = this.db
      .prepare('SELECT json, seq FROM conflicts WHERE seq > ? ORDER BY seq ASC')
      .all(sinceSeq) as { json: string; seq: number }[];

    const conflicts: (Conflict & { seq: number })[] = conflictRows.map((row) => ({
      ...JSON.parse(row.json),
      seq: row.seq,
    }));

    return {
      records,
      conflicts,
      seq: currentSeq,
      epoch: this.getEpoch(),
      reset: false,
    };
  }

  resolve(
    conflictId: string,
    choice: ResolveChoice,
    by: Resolver,
  ): { ok: boolean; reason?: string; seq?: number } {
    const tx = this.db.transaction(() => {
      const state = this.loadServerState();
      const auditCountBefore = state.audit.length;
      const logCountBefore = state.log.length;

      const res = resolveConflict(state, conflictId, choice, by);
      if (!res.ok) {
        return res;
      }

      const nextSeq = this.incrementSeq();

      // Persist updated conflict
      const c = state.conflicts.find((x) => x.id === conflictId);
      if (c) {
        this.db
          .prepare(
            `UPDATE conflicts SET json = ?, status = ?, seq = ? WHERE id = ?`,
          )
          .run(JSON.stringify(c), c.status, nextSeq, c.id);
      }

      // Persist updated record
      if (c) {
        const rec = state.records[c.recordId];
        if (rec) {
          this.db
            .prepare(
              `UPDATE records SET
                fields_json = ?,
                deleted = ?,
                deleted_hlc = ?,
                deleted_by_json = ?,
                version = ?,
                seq = ?
               WHERE id = ?`,
            )
            .run(
              JSON.stringify(rec.fields),
              rec.deleted ? 1 : 0,
              rec.deletedHlc,
              rec.deletedBy ? JSON.stringify(rec.deletedBy) : null,
              rec.version,
              nextSeq,
              rec.id,
            );
        }
      }

      // Persist synthesized ops
      const newOps = state.log.slice(logCountBefore);
      const insertOpStmt = this.db.prepare(`
        INSERT INTO ops (op_id, record_id, device_id, user_id, op_json, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const o of newOps) {
        insertOpStmt.run(o.opId, o.recordId, o.deviceId, o.userId, JSON.stringify(o), 'applied');
      }

      // Persist audit
      const newAudits = state.audit.slice(auditCountBefore);
      const insertAuditStmt = this.db.prepare(`
        INSERT INTO audit (at, kind, record_id, user_id, op_id, conflict_id, detail)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const a of newAudits) {
        insertAuditStmt.run(
          a.at,
          a.kind,
          a.recordId,
          a.userId,
          a.opId ?? null,
          a.conflictId ?? null,
          a.detail ?? null,
        );
      }

      return { ok: true, seq: nextSeq };
    });

    return tx();
  }

  getAudit(recordId?: string, limit = 100): AuditEntry[] {
    let query = 'SELECT at, kind, record_id, user_id, op_id, conflict_id, detail FROM audit';
    const params: unknown[] = [];
    if (recordId) {
      query += ' WHERE record_id = ?';
      params.push(recordId);
    }
    query += ' ORDER BY seq DESC LIMIT ?';
    params.push(limit);

    const rows = this.db.prepare(query).all(...params) as {
      at: string;
      kind: AuditEntry['kind'];
      record_id: string;
      user_id: string;
      op_id: string | null;
      conflict_id: string | null;
      detail: string | null;
    }[];

    return rows.map((r) => ({
      at: r.at,
      kind: r.kind,
      recordId: r.record_id,
      userId: r.user_id,
      opId: r.op_id ?? undefined,
      conflictId: r.conflict_id ?? undefined,
      detail: r.detail ?? undefined,
    }));
  }

  getStats(): StatsResult {
    const recordsCount = (this.db.prepare('SELECT COUNT(*) as c FROM records').get() as { c: number }).c;
    const conflictsCount = (
      this.db.prepare("SELECT COUNT(*) as c FROM conflicts WHERE status = 'open'").get() as { c: number }
    ).c;
    const opsCount = (this.db.prepare('SELECT COUNT(*) as c FROM ops').get() as { c: number }).c;
    const lastSeq = this.getSeq();

    return {
      records: recordsCount,
      openConflicts: conflictsCount,
      ops: opsCount,
      lastSeq,
    };
  }

  /** Counts ops (and distinct opIds) and records whose ids start with `prefix`. */
  countByPrefix(prefix: string): { ops: number; distinctOpIds: number; records: number } {
    const ops = this.db
      .prepare('SELECT COUNT(*) AS c, COUNT(DISTINCT op_id) AS d FROM ops WHERE substr(op_id, 1, length(?)) = ?')
      .get(prefix, prefix) as { c: number; d: number };
    const records = this.db
      .prepare('SELECT COUNT(*) AS c FROM records WHERE substr(id, 1, length(?)) = ?')
      .get(prefix, prefix) as { c: number };
    return { ops: ops.c, distinctOpIds: ops.d, records: records.c };
  }

  seedDemoData(): void {
    const tx = this.db.transaction(() => {
      // Clear tables
      this.db.exec(`
        DELETE FROM records;
        DELETE FROM ops;
        DELETE FROM conflicts;
        DELETE FROM audit;
      `);
      // seq stays monotonic across a reset; the new epoch tells clients to drop their state.
      this.db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(newEpoch(), 'epoch');

      const households = [
        { id: 'h_01', name: 'Rao family', phone: '98300 11122', address: 'Ward 4, House 12', status: 'follow-up', notes: 'Child under 5 needs vaccination check', author: 'Meera' },
        { id: 'h_02', name: 'Sharma family', phone: '98300 22233', address: 'Ward 4, House 15', status: 'new', notes: 'First survey, 3 members', author: 'Dev' },
        { id: 'h_03', name: 'Patel family', phone: '98300 33344', address: 'Ward 5, House 02', status: 'completed', notes: 'All immunizations up to date', author: 'Meera' },
        { id: 'h_04', name: 'Deshmukh family', phone: '98300 44455', address: 'Ward 5, House 08', status: 'new', notes: 'Follow-up on maternal health card', author: 'Dev' },
        { id: 'h_05', name: 'Verma family', phone: '98300 55566', address: 'Ward 6, House 21', status: 'follow-up', notes: 'Elderly resident with hypertension', author: 'Arjun' },
        { id: 'h_06', name: 'Kulkarni family', phone: '98300 66677', address: 'Ward 6, House 24', status: 'completed', notes: 'Water sanitation survey recorded', author: 'Meera' },
        { id: 'h_07', name: 'Singh family', phone: '98300 77788', address: 'Ward 7, House 03', status: 'new', notes: 'New migrants, nutrition assessment needed', author: 'Dev' },
        { id: 'h_08', name: 'Joshi family', phone: '98300 88899', address: 'Ward 7, House 19', status: 'follow-up', notes: 'Scheduled for booster dose next week', author: 'Meera' },
        { id: 'h_09', name: 'Gupta family', phone: '98300 99900', address: 'Ward 8, House 05', status: 'completed', notes: 'Routine check complete', author: 'Arjun' },
        { id: 'h_10', name: 'Nair family', phone: '98300 12345', address: 'Ward 8, House 11', status: 'new', notes: 'Infant health check scheduled', author: 'Dev' },
        { id: 'h_11', name: 'Chatterjee family', phone: '98300 23456', address: 'Ward 9, House 14', status: 'follow-up', notes: 'Needs second visit for lab reports', author: 'Meera' },
        { id: 'h_12', name: 'Reddy family', phone: '98300 34567', address: 'Ward 9, House 30', status: 'completed', notes: 'Fully covered under district scheme', author: 'Arjun' },
      ];

      let baseTime = 1_770_000_000_000;
      for (const h of households) {
        baseTime += 60_000;
        const seedHlc = hlc.format({ wall: baseTime, counter: 0, node: h.author.toLowerCase() });
        const seq = this.incrementSeq();

        const fields = {
          name: { value: h.name, hlc: seedHlc, opId: `seed_op_${h.id}_name`, deviceId: `dev_${h.author.toLowerCase()}`, userId: h.author },
          phone: { value: h.phone, hlc: seedHlc, opId: `seed_op_${h.id}_phone`, deviceId: `dev_${h.author.toLowerCase()}`, userId: h.author },
          address: { value: h.address, hlc: seedHlc, opId: `seed_op_${h.id}_addr`, deviceId: `dev_${h.author.toLowerCase()}`, userId: h.author },
          status: { value: h.status, hlc: seedHlc, opId: `seed_op_${h.id}_stat`, deviceId: `dev_${h.author.toLowerCase()}`, userId: h.author },
          notes: { value: h.notes, hlc: seedHlc, opId: `seed_op_${h.id}_note`, deviceId: `dev_${h.author.toLowerCase()}`, userId: h.author },
        };

        this.db.prepare(`
          INSERT INTO records (id, fields_json, deleted, deleted_hlc, deleted_by_json, version, seq)
          VALUES (?, ?, 0, NULL, NULL, ?, ?)
        `).run(h.id, JSON.stringify(fields), seedHlc, seq);

        const opPayload: Op = {
          opId: `seed_op_${h.id}`,
          deviceId: `dev_${h.author.toLowerCase()}`,
          userId: h.author,
          recordId: h.id,
          type: 'create',
          fields: {
            name: h.name,
            phone: h.phone,
            address: h.address,
            status: h.status,
            notes: h.notes,
          },
          baseHlc: null,
          hlc: seedHlc,
        };

        this.db.prepare(`
          INSERT INTO ops (op_id, record_id, device_id, user_id, op_json, status)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(opPayload.opId, h.id, opPayload.deviceId, opPayload.userId, JSON.stringify(opPayload), 'applied');

        this.db.prepare(`
          INSERT INTO audit (at, kind, record_id, user_id, op_id, conflict_id, detail)
          VALUES (?, 'op-applied', ?, ?, ?, NULL, 'create')
        `).run(seedHlc, h.id, h.author, opPayload.opId);
      }
    });

    tx();
  }
}
