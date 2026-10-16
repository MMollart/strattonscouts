import type { Env } from '../../../_lib/http';
import { error, json, now } from '../../../_lib/http';
import { requirePermission } from '../../../_lib/auth';
import { resourceUpsertSchema } from '@shared/validation';
import { checkParent } from '../../../_lib/hierarchy';
import { DESCENDANTS_SQL } from '../../../_lib/availability-sql';
import { audited } from '../../../_lib/audit';

// Admin: update a resource (edit, enable/disable, approval, model, description).
export const onRequestPut: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requirePermission(env, request, 'resources.manage');
  if (user instanceof Response) return user;
  const id = String(params.id);

  const existing = await env.DB.prepare('SELECT id FROM resources WHERE id = ?').bind(id).first();
  if (!existing) return error('Resource not found', 404);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error('Invalid JSON body');
  }
  const parsed = resourceUpsertSchema.safeParse(body);
  if (!parsed.success) return error('Validation failed', 400, parsed.error.flatten());

  const slugClash = await env.DB.prepare('SELECT id FROM resources WHERE slug = ? AND id != ?')
    .bind(parsed.data.slug, id)
    .first();
  if (slugClash) return error('A resource with this slug already exists', 409);

  const parentProblem = await checkParent(env, id, parsed.data.parent_id);
  if (parentProblem) return error(parentProblem, 400);

  // Setting the parent re-checks for a loop in the same statement, so two
  // admins saving at once cannot close one.
  const result = await audited(env, { actor: user, action: 'resource.updated', table: 'resources', id }, () =>
    env.DB.prepare(
      `UPDATE resources SET name = ?, slug = ?, description = ?, parent_id = ?, is_active = ?, requires_approval = ?, pricing_model = ?, updated_at = ?
       WHERE id = ? AND (? IS NULL OR ? NOT IN (${DESCENDANTS_SQL}))`,
    )
      .bind(
        parsed.data.name,
        parsed.data.slug,
        parsed.data.description,
        parsed.data.parent_id,
        parsed.data.is_active ? 1 : 0,
        parsed.data.requires_approval ? 1 : 0,
        parsed.data.pricing_model,
        now(),
        id,
        parsed.data.parent_id,
        parsed.data.parent_id,
        id,
      )
      .run());
  if (!result.meta.changes) return error('That parent would make a loop. Please reload and try again.', 409);

  return json({ ok: true });
};
