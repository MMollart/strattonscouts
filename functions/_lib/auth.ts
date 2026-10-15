import type { Env } from './http';
import { newId, now } from './http';
import { randomToken, sha256Hex } from './crypto';
import type { RoleName } from '@shared/types';

const SESSION_COOKIE = 'ss_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

export interface AuthUser {
  id: string;
  email: string;
  full_name: string;
  pricing_category_id: string;
  roles: RoleName[];
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  return attrs.join('; ');
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

/** Create a session for a user. Returns the raw token to set in a cookie. */
export async function createSession(env: Env, userId: string): Promise<{ token: string; maxAge: number }> {
  const token = randomToken(32);
  const id = await sha256Hex(token); // store only the hash
  const createdAt = now();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await env.DB.prepare(
    'INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
  )
    .bind(id, userId, createdAt, expiresAt)
    .run();
  return { token, maxAge: Math.floor(SESSION_TTL_MS / 1000) };
}

export async function destroySession(env: Env, request: Request): Promise<void> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return;
  const id = await sha256Hex(token);
  await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
}

/** Resolve the currently authenticated user from the request cookie. */
export async function getAuthUser(env: Env, request: Request): Promise<AuthUser | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const id = await sha256Hex(token);
  const session = await env.DB.prepare(
    'SELECT user_id, expires_at FROM sessions WHERE id = ?',
  )
    .bind(id)
    .first<{ user_id: string; expires_at: string }>();
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
    return null;
  }
  const user = await env.DB.prepare(
    'SELECT id, email, full_name, pricing_category_id FROM users WHERE id = ?',
  )
    .bind(session.user_id)
    .first<{ id: string; email: string; full_name: string; pricing_category_id: string }>();
  if (!user) return null;
  const roleRows = await env.DB.prepare(
    `SELECT r.name AS name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?`,
  )
    .bind(user.id)
    .all<{ name: RoleName }>();
  return { ...user, roles: roleRows.results.map((r) => r.name) };
}

export function isAdmin(user: AuthUser | null): boolean {
  return !!user && (user.roles.includes('admin') || user.roles.includes('super_admin'));
}

export function isSuperAdmin(user: AuthUser | null): boolean {
  return !!user && user.roles.includes('super_admin');
}

/**
 * Basic sliding-window rate limiting backed by the auth_attempts table.
 * Returns true if the action is allowed (under the limit).
 */
export async function rateLimit(
  env: Env,
  identifier: string,
  action: string,
  limit: number,
  windowMs: number,
): Promise<boolean> {
  const since = new Date(Date.now() - windowMs).toISOString();
  // Count and record in one statement so concurrent requests cannot all slip
  // under the limit.
  const result = await env.DB.prepare(
    `INSERT INTO auth_attempts (id, identifier, action, created_at)
     SELECT ?, ?, ?, ?
     WHERE (SELECT COUNT(*) FROM auth_attempts WHERE identifier = ? AND action = ? AND created_at >= ?) < ?`,
  )
    .bind(newId('att'), identifier, action, now(), identifier, action, since, limit)
    .run();
  return result.meta.changes === 1;
}

export function clientIp(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for') ?? 'unknown';
}
