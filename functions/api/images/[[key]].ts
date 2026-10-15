import type { Env } from '../../_lib/http';

// Public: serve a resource image from R2 by key. Path: /api/images/<key...>
export const onRequestGet: PagesFunction<Env> = async ({ env, params }) => {
  const parts = params.key;
  const key = Array.isArray(parts) ? parts.join('/') : String(parts);

  // Only allow serving objects under the resources/ prefix.
  if (!key.startsWith('resources/')) {
    return new Response('Not found', { status: 404 });
  }

  const object = await env.BUCKET.get(key);
  if (!object) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('cache-control', 'public, max-age=86400');
  return new Response(object.body, { headers });
};
