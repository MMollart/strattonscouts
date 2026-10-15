import type { Env } from '../_lib/http';
import { json } from '../_lib/http';

// Public: list customer pricing categories (for registration + display).
export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const rows = await env.DB.prepare(
    'SELECT id, name, label, sort_order FROM pricing_categories ORDER BY sort_order',
  ).all();
  return json(rows.results);
};
