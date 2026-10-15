import type { Env } from './_lib/http';

// Global middleware: add baseline security headers to every response.
export const onRequest: PagesFunction<Env> = async (context) => {
  const response = await context.next();
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
