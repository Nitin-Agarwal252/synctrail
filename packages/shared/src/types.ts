/** Hybrid Logical Clock, serialized so plain string comparison orders correctly. */
export type Hlc = string;

export type FieldValue = string | number | boolean | null;

export interface FieldState {
  value: FieldValue;
  hlc: Hlc;
  opId: string;
  deviceId: string;
  userId: string;
}

export interface RecordState {
  id: string;
  fields: Record<string, FieldState>;
  deleted: boolean;
  /** HLC of the delete op while deleted, else null. */
  deletedHlc: Hlc | null;
  deletedBy: { deviceId: string; userId: string } | null;
  /** Max HLC of every applied change to this record. Informational and used for ordering in UIs. */
  version: Hlc;
}

export type OpType = 'create' | 'set' | 'delete' | 'restore';

export interface Op {
  /** Globally unique. The server dedupes on this, which makes retries safe. */
  opId: string;
  deviceId: string;
  userId: string;
  recordId: string;
  type: OpType;
  /** create: initial fields */
  fields?: Record<string, FieldValue>;
  /** set: single field change */
  field?: string;
  value?: FieldValue;
  /**
   * set only: the HLC of the field version the author SAW when editing
   * (null if the field did not exist). Everything else: null.
   * Equality of this value with the server's current field HLC is what proves
   * "no one else changed it since you looked", independent of clocks or arrival order.
   */
  baseHlc: Hlc | null;
  /**
   * delete only: snapshot of the author's local view, field name -> field HLC.
   * The delete is a conflict if another author changed any field since.
   */
  seen?: Record<string, Hlc>;
  hlc: Hlc;
}

export type ConflictKind = 'field' | 'edit-vs-delete' | 'delete-vs-edit';

export interface Conflict {
  id: string;
  recordId: string;
  kind: ConflictKind;
  /** null for delete-vs-edit */
  field: string | null;
  /** Value at the common ancestor, if it can be found in the op log. */
  baseValue: FieldValue | undefined;
  /** What the server holds now. */
  theirs: { value: FieldValue | undefined; hlc: Hlc; deviceId: string; userId: string };
  /** The incoming op that could not be applied. */
  mine: Op;
  status: 'open' | 'resolved';
  resolution?: { choice: 'mine' | 'theirs' | 'custom'; value?: FieldValue; byUserId: string; hlc: Hlc };
}

export type ApplyStatus = 'applied' | 'noop' | 'duplicate' | 'conflict' | 'rejected';

export interface ApplyResult {
  opId: string;
  status: ApplyStatus;
  conflictId?: string;
  reason?: string;
}

export interface AuditEntry {
  at: Hlc;
  kind: 'op-applied' | 'op-noop' | 'conflict-opened' | 'conflict-resolved';
  opId?: string;
  conflictId?: string;
  recordId: string;
  userId: string;
  detail?: string;
}

export interface ServerState {
  records: Record<string, RecordState>;
  /** Every op ever accepted, in arrival order. Never mutated. */
  log: Op[];
  seenOps: Set<string>;
  conflicts: Conflict[];
  audit: AuditEntry[];
}

export type ResolveChoice =
  | { choice: 'mine' }
  | { choice: 'theirs' }
  | { choice: 'custom'; value: FieldValue };
