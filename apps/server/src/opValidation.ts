import type { ApplyResult, FieldValue, Op, OpType } from '@synctrail/shared';

export const HLC_PATTERN = /^\d{15}:\d{5}:[^:\s]+$/;
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const ALLOWED_FIELDS = ['name', 'phone', 'address', 'status', 'notes'] as const;
export const ALLOWED_STATUS = ['new', 'follow-up', 'completed'] as const;
export const MAX_OPS_PER_BATCH = 50;

const ALLOWED_FIELD_SET = new Set<string>(ALLOWED_FIELDS);
const ALLOWED_STATUS_SET = new Set<string>(ALLOWED_STATUS);
const OP_TYPES = new Set<string>(['create', 'set', 'delete', 'restore']);

function rejected(opId: string, detail: string): ApplyResult {
  return { opId, status: 'rejected', reason: `invalid-op: ${detail}` };
}

function hasProtoKey(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Object.prototype.hasOwnProperty.call(value, '__proto__')) return true;
  return Object.keys(value as object).some((k) => k === '__proto__');
}

function isFieldValue(v: unknown): v is FieldValue {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

function invalidId(id: unknown): boolean {
  return typeof id !== 'string' || !ID_PATTERN.test(id);
}

function invalidHlc(h: unknown): boolean {
  return typeof h !== 'string' || !HLC_PATTERN.test(h);
}

/**
 * Envelope-level check: malformed request bodies return 400.
 * Per-op checks belong in validateOpShape — those must not abort the batch.
 */
export function validateEnvelopeOps(ops: unknown): { ok: true; ops: unknown[] } | { ok: false; error: string } {
  if (!Array.isArray(ops)) {
    return { ok: false, error: 'ops must be an array' };
  }
  if (ops.length > MAX_OPS_PER_BATCH) {
    return { ok: false, error: `ops exceeds max ${MAX_OPS_PER_BATCH}` };
  }
  return { ok: true, ops };
}

/**
 * Returns a rejected ApplyResult if the payload is not a legal Op.
 * Otherwise returns the typed Op for applyOp / previewOps.
 */
export function validateOpShape(raw: unknown): { ok: true; op: Op } | { ok: false; result: ApplyResult } {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, result: rejected('unknown', 'not-an-object') };
  }

  const obj = raw as Record<string, unknown>;
  const opId = typeof obj.opId === 'string' ? obj.opId : 'unknown';

  if (hasProtoKey(obj)) {
    return { ok: false, result: rejected(opId, '__proto__') };
  }

  if (invalidId(obj.opId) || invalidId(obj.deviceId) || invalidId(obj.userId) || invalidId(obj.recordId)) {
    return { ok: false, result: rejected(opId, 'id') };
  }

  if (typeof obj.type !== 'string' || !OP_TYPES.has(obj.type)) {
    return { ok: false, result: rejected(opId, 'type') };
  }

  if (invalidHlc(obj.hlc)) {
    return { ok: false, result: rejected(opId, 'hlc') };
  }

  if (obj.baseHlc !== undefined && obj.baseHlc !== null && invalidHlc(obj.baseHlc)) {
    return { ok: false, result: rejected(opId, 'hlc') };
  }

  if (obj.fields !== undefined) {
    if (obj.fields === null || typeof obj.fields !== 'object' || Array.isArray(obj.fields)) {
      return { ok: false, result: rejected(opId, 'field') };
    }
    if (hasProtoKey(obj.fields)) {
      return { ok: false, result: rejected(opId, '__proto__') };
    }
    for (const [key, val] of Object.entries(obj.fields as Record<string, unknown>)) {
      if (key === '__proto__') {
        return { ok: false, result: rejected(opId, '__proto__') };
      }
      if (!ALLOWED_FIELD_SET.has(key)) {
        return { ok: false, result: rejected(opId, 'field') };
      }
      if (!isFieldValue(val)) {
        return { ok: false, result: rejected(opId, 'field') };
      }
      if (key === 'status' && (typeof val !== 'string' || !ALLOWED_STATUS_SET.has(val))) {
        return { ok: false, result: rejected(opId, 'status') };
      }
    }
  }

  if (obj.field !== undefined) {
    if (obj.field === '__proto__') {
      return { ok: false, result: rejected(opId, '__proto__') };
    }
    if (typeof obj.field !== 'string' || !ALLOWED_FIELD_SET.has(obj.field)) {
      return { ok: false, result: rejected(opId, 'field') };
    }
  }

  if (obj.seen !== undefined) {
    if (obj.seen === null || typeof obj.seen !== 'object' || Array.isArray(obj.seen)) {
      return { ok: false, result: rejected(opId, 'field') };
    }
    if (hasProtoKey(obj.seen)) {
      return { ok: false, result: rejected(opId, '__proto__') };
    }
    for (const [key, val] of Object.entries(obj.seen as Record<string, unknown>)) {
      if (key === '__proto__') {
        return { ok: false, result: rejected(opId, '__proto__') };
      }
      if (!ALLOWED_FIELD_SET.has(key) || invalidHlc(val)) {
        return { ok: false, result: rejected(opId, key === '__proto__' ? '__proto__' : 'hlc') };
      }
    }
  }

  const type = obj.type as OpType;

  if (type === 'set') {
    if (typeof obj.field !== 'string' || !ALLOWED_FIELD_SET.has(obj.field)) {
      return { ok: false, result: rejected(opId, 'field') };
    }
    if (!('value' in obj) || !isFieldValue(obj.value)) {
      return { ok: false, result: rejected(opId, 'missing-value') };
    }
    if (obj.field === 'status' && (typeof obj.value !== 'string' || !ALLOWED_STATUS_SET.has(obj.value))) {
      return { ok: false, result: rejected(opId, 'status') };
    }
  }

  const op: Op = {
    opId: obj.opId as string,
    deviceId: obj.deviceId as string,
    userId: obj.userId as string,
    recordId: obj.recordId as string,
    type,
    fields: obj.fields as Op['fields'],
    field: obj.field as Op['field'],
    value: obj.value as Op['value'],
    baseHlc: (obj.baseHlc ?? null) as Op['baseHlc'],
    seen: obj.seen as Op['seen'],
    hlc: obj.hlc as string,
  };

  return { ok: true, op };
}

export function classifyOps(rawOps: unknown[]): { op: Op | null; preResult?: ApplyResult }[] {
  return rawOps.map((raw) => {
    const checked = validateOpShape(raw);
    if (!checked.ok) {
      return { op: null, preResult: checked.result };
    }
    return { op: checked.op };
  });
}
