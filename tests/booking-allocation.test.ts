import { describe, it, expect, beforeEach } from 'vitest';
import { createBookingAtomic } from '../functions/_lib/booking';
import type { Env } from '../functions/_lib/http';

/**
 * A tiny in-memory D1-compatible mock sufficient for the booking engine.
 * It stores rows in arrays and interprets the specific SQL shapes the engine
 * uses. batch() is serialised via a shared async lock to emulate D1's single
 * serialised transaction semantics, which is what the concurrency guard relies
 * on. Each statement also yields to the event loop so interleaving is possible
 * everywhere EXCEPT inside a batch (mirroring real transactional behaviour).
 */
interface Row {
  [k: string]: unknown;
}

class MockDB {
  resources: Row[] = [];
  users: Row[] = [];
  pricing: Row[] = [];
  closures: Row[] = [];
  conflicts: Row[] = [];
  bookings: Row[] = [];
  bookingResources: Row[] = [];
  bookingEvents: Row[] = [];
  private lock: Promise<void> = Promise.resolve();

  prepare(sql: string) {
    return new MockStatement(this, sql.replace(/\s+/g, ' ').trim());
  }

  async batch(stmts: MockStatement[]) {
    // Serialise batches: acquire the lock, run all statements without yielding
    // to other batches, then release.
    let release!: () => void;
    const previous = this.lock;
    this.lock = new Promise<void>((r) => (release = r));
    await previous;
    try {
      const out = [];
      for (const s of stmts) out.push(s.runSync());
      return out;
    } finally {
      release();
    }
  }
}

class MockStatement {
  private binds: unknown[] = [];
  constructor(private db: MockDB, private sql: string) {}
  bind(...args: unknown[]) {
    this.binds = args;
    return this;
  }
  async first<T>(): Promise<T | null> {
    await tick();
    return this.exec() as T | null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    await tick();
    return { results: (this.execAll() as T[]) };
  }
  async run() {
    await tick();
    this.runSync();
    return { success: true };
  }
  runSync() {
    this.exec();
    return { success: true };
  }

  private execAll(): Row[] {
    const s = this.sql;
    if (s.startsWith('SELECT resource_id, conflicts_with_id FROM resource_conflicts')) {
      const [rid, rid2] = this.binds as string[];
      return this.db.conflicts.filter((c) => c.resource_id === rid || c.conflicts_with_id === rid2);
    }
    return [];
  }

  private exec(): Row | null {
    const s = this.sql;
    const b = this.binds;

    if (s.startsWith('SELECT id, is_active, requires_approval, pricing_model FROM resources')) {
      return this.db.resources.find((r) => r.id === b[0]) ?? null;
    }
    if (s.startsWith('SELECT pricing_category_id FROM users')) {
      return this.db.users.find((u) => u.id === b[0]) ?? null;
    }
    if (s.startsWith('SELECT amount_pence, is_free FROM resource_pricing')) {
      return this.db.pricing.find((p) => p.resource_id === b[0] && p.category_id === b[1]) ?? null;
    }
    if (s.startsWith('SELECT id FROM resource_closures')) {
      const [rid, endsAt, startsAt] = b as string[];
      return (
        this.db.closures.find(
          (c) => c.resource_id === rid && (c.starts_at as string) < endsAt && (c.ends_at as string) > startsAt,
        ) ?? null
      );
    }
    if (s.startsWith('SELECT COUNT(*) AS c FROM bookings')) {
      // bind order: ...ACTIVE_STATUSES, ...blocked, endsAt, startsAt
      const statuses = ['pending_approval', 'confirmed'];
      const rest = b.slice(statuses.length) as string[];
      const endsAt = rest[rest.length - 2];
      const startsAt = rest[rest.length - 1];
      const blocked = rest.slice(0, rest.length - 2);
      const c = this.db.bookings.filter(
        (bk) =>
          statuses.includes(bk.status as string) &&
          blocked.includes(bk.resource_id as string) &&
          (bk.starts_at as string) < endsAt &&
          (bk.ends_at as string) > startsAt,
      ).length;
      return { c };
    }
    if (s.startsWith('SELECT id FROM bookings')) {
      // winner query: ORDER BY created_at ASC, id ASC LIMIT 1
      const statuses = ['pending_approval', 'confirmed'];
      const rest = b.slice(statuses.length) as string[];
      const endsAt = rest[rest.length - 2];
      const startsAt = rest[rest.length - 1];
      const blocked = rest.slice(0, rest.length - 2);
      const candidates = this.db.bookings
        .filter(
          (bk) =>
            statuses.includes(bk.status as string) &&
            blocked.includes(bk.resource_id as string) &&
            (bk.starts_at as string) < endsAt &&
            (bk.ends_at as string) > startsAt,
        )
        .sort((x, y) => {
          const t = (x.created_at as string).localeCompare(y.created_at as string);
          return t !== 0 ? t : (x.id as string).localeCompare(y.id as string);
        });
      return candidates[0] ?? null;
    }
    if (s.startsWith('INSERT INTO bookings')) {
      this.db.bookings.push({
        id: b[0], reference: b[1], user_id: b[2], resource_id: b[3], starts_at: b[4], ends_at: b[5],
        status: b[6], category_id: b[7], pricing_model: b[8], unit_price_pence: b[9], total_amount_pence: b[10],
        created_at: b[11], updated_at: b[12],
      });
      return null;
    }
    if (s.startsWith('INSERT INTO booking_resources')) {
      this.db.bookingResources.push({ booking_id: b[0], resource_id: b[1] });
      return null;
    }
    if (s.startsWith('INSERT INTO booking_events')) {
      this.db.bookingEvents.push({ id: b[0], booking_id: b[1], event_type: b[2] });
      return null;
    }
    if (s.startsWith('DELETE FROM booking_events')) {
      this.db.bookingEvents = this.db.bookingEvents.filter((e) => e.booking_id !== b[0]);
      return null;
    }
    if (s.startsWith('DELETE FROM booking_resources')) {
      this.db.bookingResources = this.db.bookingResources.filter((e) => e.booking_id !== b[0]);
      return null;
    }
    if (s.startsWith('DELETE FROM bookings')) {
      this.db.bookings = this.db.bookings.filter((e) => e.id !== b[0]);
      return null;
    }
    throw new Error(`Unhandled SQL in mock: ${s}`);
  }
}

function tick() {
  return new Promise((r) => setTimeout(r, 0));
}

function makeEnv(): { env: Env; db: MockDB } {
  const db = new MockDB();
  db.resources.push({ id: 'main', is_active: 1, requires_approval: 0, pricing_model: 'hourly' });
  db.resources.push({ id: 'whole', is_active: 1, requires_approval: 1, pricing_model: 'fixed' });
  db.users.push({ id: 'u1', pricing_category_id: 'cat_scouts' });
  db.users.push({ id: 'u2', pricing_category_id: 'cat_scouts' });
  db.pricing.push({ resource_id: 'main', category_id: 'cat_scouts', amount_pence: 1000, is_free: 0 });
  db.pricing.push({ resource_id: 'whole', category_id: 'cat_scouts', amount_pence: 5000, is_free: 0 });
  // self conflicts + whole<->main
  db.conflicts.push({ resource_id: 'main', conflicts_with_id: 'main' });
  db.conflicts.push({ resource_id: 'whole', conflicts_with_id: 'whole' });
  db.conflicts.push({ resource_id: 'whole', conflicts_with_id: 'main' });
  db.conflicts.push({ resource_id: 'main', conflicts_with_id: 'whole' });
  const env = { DB: db } as unknown as Env;
  return { env, db };
}

const win = { startsAt: '2026-06-01T10:00:00Z', endsAt: '2026-06-01T12:00:00Z' };

describe('atomic booking allocation', () => {
  let env: Env;
  let db: MockDB;
  beforeEach(() => {
    ({ env, db } = makeEnv());
  });

  it('auto-confirms when approval is not required (AC13)', async () => {
    const r = await createBookingAtomic({ env, userId: 'u1', resourceId: 'main', ...win, actorId: 'u1' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.status).toBe('confirmed');
      expect(r.totalPence).toBe(2000);
    }
  });

  it('enters pending_approval when the resource requires approval (AC14/AC15)', async () => {
    const r = await createBookingAtomic({ env, userId: 'u1', resourceId: 'whole', ...win, actorId: 'u1' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.status).toBe('pending_approval');
    // Reserved: blocks a conflicting resource.
    const conflicting = await createBookingAtomic({ env, userId: 'u2', resourceId: 'main', ...win, actorId: 'u2' });
    expect(conflicting.ok).toBe(false);
  });

  it('rejects a conflicting booking across the Whole Venue relationship (AC11)', async () => {
    const first = await createBookingAtomic({ env, userId: 'u1', resourceId: 'main', ...win, actorId: 'u1' });
    expect(first.ok).toBe(true);
    const second = await createBookingAtomic({ env, userId: 'u2', resourceId: 'whole', ...win, actorId: 'u2' });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe('conflict');
  });

  it('never allows two concurrent conflicting bookings to both succeed (AC12)', async () => {
    // Fire many conflicting requests "simultaneously".
    const attempts = Array.from({ length: 20 }, (_, i) =>
      createBookingAtomic({ env, userId: i % 2 === 0 ? 'u1' : 'u2', resourceId: i % 2 === 0 ? 'main' : 'whole', ...win, actorId: 'u1' }),
    );
    const results = await Promise.all(attempts);
    const successes = results.filter((r) => r.ok);
    expect(successes.length).toBe(1);
    // Exactly one booking persisted.
    expect(db.bookings.length).toBe(1);
  });
});
