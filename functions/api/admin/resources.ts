import type { Env } from '../../_lib/http';
import { error, json, newId, now } from '../../_lib/http';
import { requirePermission } from '../../_lib/auth';
import { resourceUpsertSchema } from '@shared/validation';
import { syncMandatoryConflicts } from '../../_lib/conflicts';

// Admin: list all resources (including inactive).
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'bookings.view');
  if (user instanceof Response) return user;
  const rows = await env.DB.prepare(
    `SELECT id, name, slug, description, resource_type, is_active, requires_approval, pricing_model, min_notice_minutes, max_advance_days, provisional_expiry_hours, created_at, updated_at
     FROM resources ORDER BY name`,
  ).all();
  return json(
    rows.results.map((r) => ({
      ...r,
      is_active: !!(r.is_active as number),
      requires_approval: !!(r.requires_approval as number),
    })),
  );
};

// Admin: create a resource.
export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'resources.manage');
  if (user instanceof Response) return user;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error('Invalid JSON body');
  }
  const parsed = resourceUpsertSchema.safeParse(body);
  if (!parsed.success) return error('Validation failed', 400, parsed.error.flatten());

  const existing = await env.DB.prepare('SELECT id FROM resources WHERE slug = ?').bind(parsed.data.slug).first();
  if (existing) return error('A resource with this slug already exists', 409);

  const id = newId('res');
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO resources (id, name, slug, description, resource_type, is_active, requires_approval, pricing_model, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      parsed.data.name,
      parsed.data.slug,
      parsed.data.description,
      parsed.data.resource_type,
      parsed.data.is_active ? 1 : 0,
      parsed.data.requires_approval ? 1 : 0,
      parsed.data.pricing_model,
      ts,
      ts,
    )
    .run();

  // Self-conflict, plus Whole Venue (combined resource) relationships.
  await syncMandatoryConflicts(env, id);

  return json({ id }, 201);
};
