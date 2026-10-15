import type { Env } from './_lib/http';
import { error } from './_lib/http';

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

// Global middleware: refuse to run production without the encryption key, and
// add baseline security headers to every response.
export const onRequest: PagesFunction<Env> = async (context) => {
  const { env, request } = context;
  if (
    env.ENVIRONMENT === 'production' &&
    !env.DATA_ENCRYPTION_KEY &&
    new URL(request.url).pathname.startsWith('/api/')
  ) {
    // Without the key, contact details would be stored unencrypted.
    return error('Service is not configured', 503);
  }

  const response = await context.next();
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
