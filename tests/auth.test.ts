import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rateLimit } from '../functions/_lib/auth';
import { sha256Hex } from '../functions/_lib/crypto';
import { onRequestPost as confirmReset } from '../functions/api/auth/password-reset-confirm';
import type { Env } from '../functions/_lib/http';
import { addUser, createTestEnv } from './helpers/d1';

let env: Env;
let db: D1Database;
let dispose: () => Promise<void>;

beforeEach(async () => {
  ({ env, db, dispose } = await createTestEnv());
});

afterEach(async () => {
  await dispose();
});

describe('authentication safeguards (real D1)', () => {
  it('admits exactly the limit when requests arrive together', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => rateLimit(env, 'ip:someone', 'login', 5, 15 * 60 * 1000)),
    );
    expect(results.filter(Boolean)).toHaveLength(5);
  });

  it('lets only one of two simultaneous resets use the same token', async () => {
    await addUser(db, 'u1');
    const token = 'reset-token-0123456789';
    const ts = new Date().toISOString();
    await db
      .prepare('INSERT INTO password_resets (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .bind('pwr1', 'u1', await sha256Hex(token), ts, new Date(Date.now() + 3600_000).toISOString())
      .run();

    const call = (password: string) =>
      confirmReset({
        env,
        request: new Request('http://localhost/api/auth/password-reset-confirm', {
          method: 'POST',
          body: JSON.stringify({ token, password }),
        }),
      } as unknown as Parameters<typeof confirmReset>[0]);

    const responses = await Promise.all([call('first-password-1'), call('second-password-2')]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 400]);
  });
});
