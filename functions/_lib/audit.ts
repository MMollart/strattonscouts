import type { Env } from './http';
import { newId, now } from './http';
import type { AuthUser } from './auth';
import { sha256Hex } from './crypto';

/**
 * Audit history (Release 3 / FR11). Every significant change is one row in
 * the append-only audit_events table (migration 0017). Booking lifecycle
 * events and administrator role changes are copied in by database triggers;
 * everything else is recorded here.
 */

export type ActorType = 'customer' | 'administrator' | 'system';

/** Who made a change: a signed-in user, or the platform itself (the scheduler). */
export type AuditActor = AuthUser | { id: string | null; type: ActorType };

export const SYSTEM_ACTOR: AuditActor = { id: null, type: 'system' };

export interface AuditEvent {
  actor: AuditActor;
  /** What happened, as `area.verb`, e.g. `pricing.rate_updated`. */
  action: string;
  entityType: string;
  entityId: string;
  entityLabel?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string | null;
  bookingId?: string | null;
  organisationId?: string | null;
  resourceId?: string | null;
}

function actorOf(actor: AuditActor): { id: string | null; type: ActorType } {
  if ('type' in actor) return actor;
  return { id: actor.id, type: actor.roles.length ? 'administrator' : 'customer' };
}

/** The actor for a user known only by id and (when loaded) their admin roles. */
export function userActor(user: { id: string; roles?: readonly string[] }): AuditActor {
  return { id: user.id, type: user.roles?.length ? 'administrator' : 'customer' };
}

// Never written to the log: credentials, tokens and contact details.
const SECRET_KEY = /password|token|secret|api_?key|cookie|session|phone|email|encrypted|signature_image/i;
// Bookkeeping columns that change on every write and say nothing new.
const NOISE_KEYS = new Set(['updated_at', 'updated_by', 'created_at']);

/** Remove credentials and personal contact details from a set of values. */
export function sanitise(values: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!values) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (NOISE_KEYS.has(k)) continue;
    out[k] = SECRET_KEY.test(k) ? (v === null || v === undefined ? v : '[redacted]') : v;
  }
  return out;
}

/** The fields that differ between two versions of a row, as { before, after }. */
export function diff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): { before: Record<string, unknown> | null; after: Record<string, unknown> | null } {
  const b = sanitise(before);
  const a = sanitise(after);
  if (!b || !a) return { before: b, after: a };
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => JSON.stringify(b[k]) !== JSON.stringify(a[k]));
  return {
    before: Object.fromEntries(keys.map((k) => [k, b[k] ?? null])),
    after: Object.fromEntries(keys.map((k) => [k, a[k] ?? null])),
  };
}

/**
 * The INSERT for one audit event, to run in the same batch as the change so
 * both happen or neither does. `onlyIfChanged` writes it only when the
 * statement just before it in the batch changed a row.
 */
export function auditStatement(env: Env, e: AuditEvent, opts: { onlyIfChanged?: boolean } = {}): D1PreparedStatement {
  const actor = actorOf(e.actor);
  const before = sanitise(e.before);
  const after = sanitise(e.after);
  return env.DB.prepare(
    `INSERT INTO audit_events (id, created_at, actor_id, actor_type, action, entity_type, entity_id, entity_label, before_json, after_json, reason, booking_id, organisation_id, resource_id)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${opts.onlyIfChanged ? ' WHERE changes() > 0' : ''}`,
  ).bind(
    newId('aud'),
    now(),
    actor.id,
    actor.type,
    e.action,
    e.entityType,
    e.entityId,
    e.entityLabel ?? null,
    before ? JSON.stringify(before) : null,
    after ? JSON.stringify(after) : null,
    e.reason ?? null,
    e.bookingId ?? null,
    e.organisationId ?? null,
    e.resourceId ?? null,
  );
}

/** Record one audit event on its own. */
export async function recordAudit(env: Env, e: AuditEvent): Promise<void> {
  await auditStatement(env, e).run();
}

// Tables whose rows are audited with `audited`, and how to name each row.
const TABLES = {
  resources: { entityType: 'resource', key: 'id', label: 'name' },
  resource_closures: { entityType: 'closure', key: 'id', label: 'reason' },
  availability_rules: { entityType: 'availability_rule', key: 'id', label: 'label' },
  base_rates: { entityType: 'base_rate', key: 'id', label: null },
  pricing_discounts: { entityType: 'discount', key: 'id', label: 'name' },
  pricing_categories: { entityType: 'pricing_category', key: 'id', label: 'label' },
  organisation_pricing: { entityType: 'organisation_pricing', key: 'id', label: null },
  organisations: { entityType: 'organisation', key: 'id', label: 'name' },
  users: { entityType: 'user', key: 'id', label: null },
  app_settings: { entityType: 'setting', key: 'key', label: 'key' },
  email_templates: { entityType: 'email_template', key: 'key', label: 'key' },
  assets: { entityType: 'asset', key: 'id', label: 'name' },
  asset_types: { entityType: 'asset_type', key: 'id', label: 'label' },
  maintenance_records: { entityType: 'maintenance', key: 'id', label: 'title' },
  maintenance_types: { entityType: 'maintenance_type', key: 'id', label: 'label' },
  resource_faults: { entityType: 'fault', key: 'id', label: 'description' },
  agreement_templates: { entityType: 'agreement', key: 'id', label: 'name' },
} as const;
export type AuditedTable = keyof typeof TABLES;

// Columns never read into the log for a table (beyond the generic secret filter).
const SKIP_COLUMNS: Partial<Record<AuditedTable, string[]>> = {
  users: ['email', 'full_name', 'password_hash', 'phone_encrypted'],
  email_templates: ['body_html', 'body_text'],
};

export async function loadAuditRow(env: Env, table: AuditedTable, id: string): Promise<Record<string, unknown> | null> {
  const row = await env.DB.prepare(`SELECT * FROM ${table} WHERE ${TABLES[table].key} = ?`).bind(id).first<Record<string, unknown>>();
  if (!row) return null;
  for (const c of SKIP_COLUMNS[table] ?? []) delete row[c];
  return row;
}

/**
 * Run a change to one row and record it with the fields it changed. `run`
 * performs the write and returns its D1 result (or whether anything
 * changed); nothing is recorded when no row changed. The row is read before
 * and after, so the log holds exactly what the database now says.
 */
export async function audited<T extends boolean | D1Result>(
  env: Env,
  args: {
    actor: AuditActor;
    action: string;
    table: AuditedTable;
    /** The row's key. For a create, the id the new row will have. */
    id: string;
    label?: string | null;
    reason?: string | null;
    bookingId?: string | null;
    organisationId?: string | null;
    resourceId?: string | null;
  },
  run: () => Promise<T>,
): Promise<T> {
  const before = await loadAuditRow(env, args.table, args.id);
  const result = await run();
  const changed = typeof result === 'boolean' ? result : (result.meta.changes ?? 0) > 0;
  if (!changed) return result;
  const after = await loadAuditRow(env, args.table, args.id);
  if (before && after) {
    const d = diff(before, after);
    if (!Object.keys(d.after ?? {}).length) return result;
  }
  const d = diff(before, after);
  const def = TABLES[args.table];
  const row = after ?? before;
  const label = args.label ?? (def.label && row?.[def.label] ? String(row[def.label]) : row ? await relatedName(env, row) : null);
  await recordAudit(env, {
    actor: args.actor,
    action: args.action,
    entityType: def.entityType,
    entityId: args.id,
    entityLabel: label ? String(label).slice(0, 200) : null,
    before: d.before,
    after: d.after,
    reason: args.reason,
    bookingId: args.bookingId,
    organisationId: args.organisationId ?? (args.table === 'organisations' ? args.id : (row?.organisation_id as string | undefined) ?? null),
    resourceId: args.resourceId ?? (args.table === 'resources' ? args.id : (row?.resource_id as string | undefined) ?? null),
  });
  return result;
}

/** A readable name for a row that has none of its own: its resource's or organisation's. */
async function relatedName(env: Env, row: Record<string, unknown>): Promise<string | null> {
  if (typeof row.resource_id === 'string') {
    return (await env.DB.prepare('SELECT name FROM resources WHERE id = ?').bind(row.resource_id).first<{ name: string }>())?.name ?? null;
  }
  if (typeof row.organisation_id === 'string') {
    return (await env.DB.prepare('SELECT name FROM organisations WHERE id = ?').bind(row.organisation_id).first<{ name: string }>())?.name ?? null;
  }
  return null;
}

// ------------------------------- Integrity --------------------------------

interface AuditRow {
  seq: number;
  id: string;
  created_at: string;
  actor_id: string | null;
  actor_type: string;
  action: string;
  entity_type: string;
  entity_id: string;
  entity_label: string | null;
  before_json: string | null;
  after_json: string | null;
  reason: string | null;
  booking_id: string | null;
  organisation_id: string | null;
  resource_id: string | null;
  prev_hash: string | null;
  hash: string | null;
}

const GENESIS = '0'.repeat(64);

/** The hash that seals a row: its content chained to the previous row's hash. */
export async function rowHash(r: AuditRow, prevHash: string): Promise<string> {
  return sha256Hex(
    JSON.stringify([
      prevHash, r.seq, r.id, r.created_at, r.actor_id, r.actor_type, r.action, r.entity_type, r.entity_id, r.entity_label,
      r.before_json, r.after_json, r.reason, r.booking_id, r.organisation_id, r.resource_id,
    ]),
  );
}

/**
 * Seal rows that have no hash yet, oldest first. Idempotent and safe to run
 * concurrently: the hash is deterministic and each UPDATE only applies to a
 * row that is still unsealed. Returns the number of rows sealed.
 */
export async function sealAuditEvents(env: Env, limit = 500): Promise<number> {
  const pending = await env.DB.prepare('SELECT * FROM audit_events WHERE hash IS NULL ORDER BY seq LIMIT ?').bind(limit).all<AuditRow>();
  if (!pending.results.length) return 0;
  const last = await env.DB.prepare('SELECT hash FROM audit_events WHERE seq < ? AND hash IS NOT NULL ORDER BY seq DESC LIMIT 1')
    .bind(pending.results[0].seq)
    .first<{ hash: string }>();
  let prev = last?.hash ?? GENESIS;
  const updates: D1PreparedStatement[] = [];
  for (const r of pending.results) {
    const hash = await rowHash(r, prev);
    updates.push(env.DB.prepare('UPDATE audit_events SET prev_hash = ?, hash = ? WHERE seq = ? AND hash IS NULL').bind(prev, hash, r.seq));
    prev = hash;
  }
  const results = await env.DB.batch(updates);
  return results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
}

export interface IntegrityReport {
  ok: boolean;
  checked: number;
  unsealed: number;
  /** The first row whose content or position no longer matches the chain. */
  broken_at?: { seq: number; id: string; created_at: string };
  head_hash: string | null;
}

/** Recompute the whole chain and report the first row that does not match. */
export async function verifyAuditChain(env: Env): Promise<IntegrityReport> {
  let prev = GENESIS;
  let checked = 0;
  let afterSeq = 0;
  for (;;) {
    const page = await env.DB.prepare('SELECT * FROM audit_events WHERE seq > ? AND hash IS NOT NULL ORDER BY seq LIMIT 1000')
      .bind(afterSeq)
      .all<AuditRow>();
    if (!page.results.length) break;
    for (const r of page.results) {
      if (r.prev_hash !== prev || (await rowHash(r, prev)) !== r.hash) {
        const unsealed = await countUnsealed(env);
        return { ok: false, checked, unsealed, broken_at: { seq: r.seq, id: r.id, created_at: r.created_at }, head_hash: prev === GENESIS ? null : prev };
      }
      prev = r.hash!;
      checked++;
      afterSeq = r.seq;
    }
  }
  return { ok: true, checked, unsealed: await countUnsealed(env), head_hash: prev === GENESIS ? null : prev };
}

async function countUnsealed(env: Env): Promise<number> {
  return (await env.DB.prepare('SELECT COUNT(*) AS c FROM audit_events WHERE hash IS NULL').first<{ c: number }>())?.c ?? 0;
}
