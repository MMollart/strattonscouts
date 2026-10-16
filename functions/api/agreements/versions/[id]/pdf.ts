import type { Env } from '../../../../_lib/http';
import { error } from '../../../../_lib/http';
import { getAuthUser } from '../../../../_lib/auth';

/**
 * The PDF attached to an agreement version (FR20 §5.7). Served only to
 * signed-in users and never cached publicly; R2 objects under agreements/
 * are not reachable through the public image route.
 */
export const onRequestGet: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await getAuthUser(env, request);
  if (!user) return error('Not authenticated', 401);
  const v = await env.DB.prepare('SELECT pdf_key, pdf_name FROM agreement_versions WHERE id = ?').bind(String(params.id)).first<{ pdf_key: string | null; pdf_name: string | null }>();
  if (!v?.pdf_key) return error('Document not found', 404);
  const object = await env.BUCKET.get(v.pdf_key);
  if (!object) return error('Document not found', 404);
  const name = (v.pdf_name ?? 'agreement.pdf').replace(/[^\w .-]/g, '_');
  return new Response(object.body, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="${name}"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
};
