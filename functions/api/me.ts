import type { Env } from '../_lib/http';
import { error, json } from '../_lib/http';
import { getAuthUser } from '../_lib/auth';
import { toPublicUser } from '../_lib/users';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const user = await getAuthUser(env, request);
  if (!user) return error('Not authenticated', 401);
  return json(await toPublicUser(env, user));
};
