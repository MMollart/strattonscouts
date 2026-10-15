/// <reference types="@cloudflare/workers-types" />

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ENVIRONMENT: string;
  APP_BASE_URL: string;
  EMAIL_PROVIDER?: string;
  EMAIL_API_KEY?: string;
  EMAIL_FROM?: string;
  /** Office 365 (Microsoft Graph) sending: the Entra ID tenant and app registration. */
  MS_TENANT_ID?: string;
  MS_CLIENT_ID?: string;
  DATA_ENCRYPTION_KEY?: string;
  BOOTSTRAP_ADMIN_TOKEN?: string;
}

export function json(data: unknown, init: number | ResponseInit = 200): Response {
  const responseInit: ResponseInit =
    typeof init === 'number' ? { status: init } : init;
  return new Response(JSON.stringify(data), {
    ...responseInit,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(responseInit.headers ?? {}),
    },
  });
}

export function error(message: string, status = 400, details?: unknown): Response {
  return json({ error: message, ...(details ? { details } : {}) }, status);
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

export function now(): string {
  return new Date().toISOString();
}

/** Short human-friendly booking reference, e.g. SS-7F3K9Q. */
export function bookingReference(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return `SS-${s}`;
}
