import type { Env } from '../../_lib/http';
import { error, json, newId, now } from '../../_lib/http';
import { getAuthUser, isAdmin } from '../../_lib/auth';
import { resourceUpsertSchema } from '@shared/validation';

// Admin: list all resources (including inactive).
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await getAuthUser(env, request);
  if (!isAdmin(user)) return error('Not authorised', 403);
  const rows = await env.DB.prepare(
    `SELECT id, name, slug, description, resource_type, is_active, requires_approval, pricing_model, created_at, updated_at
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
  const user = await getAuthUser(env, request);
  if (!isAdmin(user)) return error('Not authorised', 403);

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

  // Mandatory self-conflict for the new resource.
  await env.DB.prepare(
    'INSERT INTO resource_conflicts (id, resource_id, conflicts_with_id, is_mandatory, created_at) VALUES (?, ?, ?, 1, ?)',
  )
    .bind(newId('rc'), id, id, ts)
    .run();

  return json({ id }, 201);
};
