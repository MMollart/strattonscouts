import type { Env } from '../../_lib/http';
import { json } from '../../_lib/http';
import { destroySession, clearSessionCookie } from '../../_lib/auth';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  await destroySession(env, request);
  return json({ ok: true }, { headers: { 'set-cookie': clearSessionCookie() } });
};
