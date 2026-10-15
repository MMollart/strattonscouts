import type { Env } from '../_lib/http';
import { json } from '../_lib/http';

// Public: organisation types offered when creating an organisation.
export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const rows = await env.DB.prepare('SELECT id, label FROM organisation_types ORDER BY sort_order').all();
  return json(rows.results);
};
