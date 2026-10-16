import type { Env } from '../_lib/http';
import { json } from '../_lib/http';
import { getSetting } from '../_lib/settings';

// Public: what the site header shows. The logo is the Email logo URL setting (blank when unset).
export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  return json({ venue_name: await getSetting(env, 'venue_name'), logo_url: await getSetting(env, 'email_logo_url') });
};
