import type { Env } from './http';

/**
 * A statement that aborts (and so rolls back) the D1 batch it is part of when
 * `condition` is true. D1 runs a batch as one transaction, so this lets a
 * multi-statement change be all-or-nothing: e.g. every occurrence of a
 * recurring booking is created, or none is.
 */
export function abortIf(env: Env, condition: string, ...binds: unknown[]): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO txn_guard (ok) SELECT 0 WHERE ${condition}`).bind(...binds);
}

/** Whether an error came from an abortIf guard. */
export function isGuardAbort(e: unknown): boolean {
  const message = e instanceof Error ? `${e.message} ${String((e as { cause?: unknown }).cause ?? '')}` : String(e);
  return message.includes('CHECK constraint failed');
}

/** Run a guarded batch. Returns null when a guard aborted it. */
export async function guardedBatch<T = unknown>(env: Env, statements: D1PreparedStatement[]): Promise<D1Result<T>[] | null> {
  try {
    return await env.DB.batch<T>(statements);
  } catch (e) {
    if (isGuardAbort(e)) return null;
    throw e;
  }
}
