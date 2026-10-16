import type { Env } from '../../../../_lib/http';
import { error, json, newId, now } from '../../../../_lib/http';
import { requirePermission } from '../../../../_lib/auth';
import { auditStatement } from '../../../../_lib/audit';

const MAX_SIZE = 5 * 1024 * 1024; // 5 MB
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];

// Admin: upload a primary image for a resource to R2. multipart/form-data: file
export const onRequestPost: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requirePermission(env, request, 'resources.manage');
  if (user instanceof Response) return user;
  const resourceId = String(params.id);

  const resource = await env.DB.prepare('SELECT id, name FROM resources WHERE id = ?').bind(resourceId).first<{ id: string; name: string }>();
  if (!resource) return error('Resource not found', 404);

  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return error('A file is required', 400);
  if (!ALLOWED.includes(file.type)) return error('Unsupported file type (jpeg, png, webp only)', 400);
  if (file.size > MAX_SIZE) return error('File exceeds 5 MB limit', 400);

  const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
  const r2Key = `resources/${resourceId}/${newId('img')}.${ext}`;
  await env.BUCKET.put(r2Key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type },
  });

  const ts = now();
  // Store metadata + reference in D1 (not the image itself). Demote old primary.
  await env.DB.batch([
    env.DB.prepare('UPDATE resource_images SET is_primary = 0 WHERE resource_id = ?').bind(resourceId),
    env.DB.prepare(
      'INSERT INTO resource_images (id, resource_id, r2_key, content_type, size_bytes, is_primary, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
    ).bind(newId('rimg'), resourceId, r2Key, file.type, file.size, ts),
    auditStatement(env, {
      actor: user,
      action: 'resource.image_uploaded',
      entityType: 'resource',
      entityId: resourceId,
      entityLabel: resource.name,
      after: { r2_key: r2Key, content_type: file.type, size_bytes: file.size },
      resourceId,
    }),
  ]);

  return json({ r2_key: r2Key }, 201);
};
