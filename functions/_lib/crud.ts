import type { Env } from './http';

/** Normalise an optional ISO date-time to canonical UTC or null. */
export function isoOrNull(v: string | null | undefined): string | null {
  return v ? new Date(v).toISOString() : null;
}

/** Whether a row with this id exists in a table (fixed, trusted table names only). */
export async function exists(env: Env, table: 'resources' | 'pricing_categories' | 'organisations' | 'users', id: string): Promise<boolean> {
  return !!(await env.DB.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).bind(id).first());
}
