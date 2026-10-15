import type { Env } from '../../../_lib/http';
import { error, json, now } from '../../../_lib/http';
import { requirePermission } from '../../../_lib/auth';
import { resourceUpsertSchema } from '@shared/validation';
import { syncMandatoryConflicts } from '../../../_lib/conflicts';

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

  await env.DB.prepare(
    `UPDATE resources SET name = ?, slug = ?, description = ?, resource_type = ?, is_active = ?, requires_approval = ?, pricing_model = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(
      parsed.data.name,
      parsed.data.slug,
      parsed.data.description,
      parsed.data.resource_type,
      parsed.data.is_active ? 1 : 0,
      parsed.data.requires_approval ? 1 : 0,
      parsed.data.pricing_model,
      now(),
      id,
    )
    .run();

  // A type change (individual <-> combined) changes the mandatory conflicts.
  await syncMandatoryConflicts(env, id);

  return json({ ok: true });
};
