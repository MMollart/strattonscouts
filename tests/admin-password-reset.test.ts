import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Env } from '../functions/_lib/http';
import { addAdmin, addUser, createTestEnv } from './helpers/d1';
import { call, sessionFor } from './helpers/http';
import * as resetPassword from '../functions/api/admin/users/[id]/password';
import * as login from '../functions/api/auth/login';

let env: Env;
let db: D1Database;
let dispose: () => Promise<void>;

beforeEach(async () => {
  ({ env, db, dispose } = await createTestEnv());
  await addAdmin(db, 'super', 'super_admin');
  await addAdmin(db, 'booker', 'booking_admin');
  await addUser(db, 'customer');
});

afterEach(async () => {
  await dispose();
});

const NEW_PASSWORD = 'correct-horse-battery';

describe('Super Admin password reset', () => {
  it('sets the new password, signs the person out and cancels their reset links', async () => {
    await sessionFor(env, 'customer');
    await db.prepare(
      "INSERT INTO password_resets (id, user_id, token_hash, created_at, expires_at, used_at) VALUES ('pr1', 'customer', 'h', ?, ?, NULL)",
    ).bind(new Date().toISOString(), new Date(Date.now() + 3600_000).toISOString()).run();

    const cookie = await sessionFor(env, 'super');
    const res = await call(resetPassword.onRequestPost, { env, cookie, params: { id: 'customer' }, body: { password: NEW_PASSWORD } });
    expect(res.status).toBe(200);

    const sessions = await db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE user_id = 'customer'").first<{ c: number }>();
    expect(sessions?.c).toBe(0);
    const link = await db.prepare("SELECT used_at FROM password_resets WHERE id = 'pr1'").first<{ used_at: string | null }>();
    expect(link?.used_at).not.toBeNull();

    const loggedIn = await call(login.onRequestPost, { env, body: { email: 'customer@example.com', password: NEW_PASSWORD } });
    expect(loggedIn.status).toBe(200);

    const audit = await db.prepare("SELECT actor_id, entity_id, before_json, after_json FROM audit_events WHERE action = 'user.password_reset'")
      .first<{ actor_id: string; entity_id: string; before_json: string | null; after_json: string | null }>();
    expect(audit).toMatchObject({ actor_id: 'super', entity_id: 'customer', before_json: null, after_json: null });
  });

  it('is limited to Super Admins', async () => {
    const cookie = await sessionFor(env, 'booker');
    const res = await call(resetPassword.onRequestPost, { env, cookie, params: { id: 'customer' }, body: { password: NEW_PASSWORD } });
    expect(res.status).toBe(403);
    const user = await db.prepare("SELECT password_hash FROM users WHERE id = 'customer'").first<{ password_hash: string }>();
    expect(user?.password_hash).toBe('x');
  });

  it('rejects short passwords, unknown users and the Super Admin’s own account', async () => {
    const cookie = await sessionFor(env, 'super');
    expect((await call(resetPassword.onRequestPost, { env, cookie, params: { id: 'customer' }, body: { password: 'short' } })).status).toBe(400);
    expect((await call(resetPassword.onRequestPost, { env, cookie, params: { id: 'nobody' }, body: { password: NEW_PASSWORD } })).status).toBe(404);
    expect((await call(resetPassword.onRequestPost, { env, cookie, params: { id: 'super' }, body: { password: NEW_PASSWORD } })).status).toBe(400);
  });
});
