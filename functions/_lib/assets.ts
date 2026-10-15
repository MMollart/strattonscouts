import type { Env } from './http';

/** Asset columns plus its type and current holder (FR07). */
export const ASSET_SELECT = `
  SELECT a.id, a.name, a.description, a.reference, a.status, a.asset_type_id, t.name AS asset_type_name,
         a.created_at, a.updated_at,
         x.id AS assignment_id, x.user_id AS assigned_user_id, u.full_name AS assigned_user_name,
         u.email AS assigned_user_email, x.assigned_at
  FROM assets a
  JOIN asset_types t ON t.id = a.asset_type_id
  LEFT JOIN asset_assignments x ON x.asset_id = a.id AND x.returned_at IS NULL
  LEFT JOIN users u ON u.id = x.user_id`;

/** Whether an error is a unique-index violation (for example a duplicate reference). */
export function isUniqueViolation(e: unknown): boolean {
  const message = e instanceof Error ? `${e.message} ${String((e as { cause?: unknown }).cause ?? '')}` : String(e);
  return message.includes('UNIQUE constraint failed');
}

/** Full assignment history of an asset, newest first. */
export async function assetHistory(env: Env, assetId: string) {
  const rows = await env.DB.prepare(
    `SELECT x.id, x.user_id, u.full_name AS user_name, u.email AS user_email,
            x.assigned_at, x.assigned_by, ab.full_name AS assigned_by_name, x.assign_notes,
            x.returned_at, x.returned_by, rb.full_name AS returned_by_name, x.return_notes, x.outcome
     FROM asset_assignments x
     JOIN users u ON u.id = x.user_id
     JOIN users ab ON ab.id = x.assigned_by
     LEFT JOIN users rb ON rb.id = x.returned_by
     WHERE x.asset_id = ? ORDER BY x.assigned_at DESC, x.rowid DESC`,
  )
    .bind(assetId)
    .all();
  return rows.results;
}
