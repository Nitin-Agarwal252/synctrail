import Database from 'better-sqlite3';

export type DatabaseInstance = Database.Database;

export function createDatabase(dbPath = ':memory:'): DatabaseInstance {
  const db = new Database(dbPath);

  // WAL mode for concurrency and performance (when on disk)
  if (dbPath !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');

  // Schema from docs/04_DATA_MODEL_AND_SYNC_PROTOCOL.md
  db.exec(`
    CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY,
      fields_json TEXT NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      deleted_hlc TEXT,
      deleted_by_json TEXT,
      version TEXT NOT NULL,
      seq INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ops (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      op_id TEXT NOT NULL UNIQUE,
      record_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      op_json TEXT NOT NULL,
      status TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conflicts (
      id TEXT PRIMARY KEY,
      record_id TEXT NOT NULL,
      json TEXT NOT NULL,
      status TEXT NOT NULL,
      seq INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      kind TEXT NOT NULL,
      record_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      op_id TEXT,
      conflict_id TEXT,
      detail TEXT
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Initialize global seq counter in meta table if not present
  const seqRow = db.prepare('SELECT value FROM meta WHERE key = ?').get('seq') as { value: string } | undefined;
  if (!seqRow) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('seq', '0');
  }

  return db;
}
