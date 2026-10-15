/* eslint-disable @typescript-eslint/no-explicit-any -- test responses are untyped JSON */
import type { Env } from '../../functions/_lib/http';
import { createSession } from '../../functions/_lib/auth';

/** A session cookie for a user, as the browser would send it. */
export async function sessionFor(env: Env, userId: string): Promise<string> {
  const { token } = await createSession(env, userId);
  return `ss_session=${token}`;
}

type Handler = PagesFunction<Env>;

/** Invoke a Pages Function handler directly and decode its JSON response. */
export async function call(
  handler: Handler,
  opts: {
    env: Env;
    method?: string;
    path?: string;
    body?: unknown;
    cookie?: string;
    params?: Record<string, string>;
  },
): Promise<{ status: number; body: any }> {
  const method = opts.method ?? (opts.body === undefined ? 'GET' : 'POST');
  const request = new Request(`http://localhost${opts.path ?? '/api/test'}`, {
    method,
    headers: { 'content-type': 'application/json', ...(opts.cookie ? { cookie: opts.cookie } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const context = {
    request,
    env: opts.env,
    params: opts.params ?? {},
    data: {},
    functionPath: opts.path ?? '/api/test',
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    next: async () => new Response(null),
  } as unknown as EventContext<Env, string, Record<string, unknown>>;
  const res = await handler(context);
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}
