import type { Env } from '../_lib/http';
import { json } from '../_lib/http';
import { getSetting } from '../_lib/settings';

// Public: what the site header shows. The logo is the Email logo URL setting (blank when unset).
export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const [venueName, logoUrl, venueAddress] = await Promise.all([
    getSetting(env, 'venue_name'),
    getSetting(env, 'email_logo_url'),
    getSetting(env, 'venue_address'),
  ]);
  return json({ venue_name: venueName, logo_url: logoUrl, venue_address: venueAddress });
};
