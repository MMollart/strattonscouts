import type { Env } from '../../_lib/http';
import { error, json, now } from '../../_lib/http';
import { requirePermission } from '../../_lib/auth';
import { SETTING_DEFINITIONS, settingsUpdateSchema } from '@shared/settings';

// Super Admin: read application settings (with defaults for unset keys).
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'settings.manage');
  if (user instanceof Response) return user;
  const rows = await env.DB.prepare('SELECT key, value FROM app_settings').all<{ key: string; value: string }>();
  const stored = Object.fromEntries(rows.results.map((r) => [r.key, r.value]));
  return json(
    SETTING_DEFINITIONS.map((d) => ({ ...d, value: stored[d.key] ?? d.default })),
  );
};

// Super Admin: update one or more settings. Body: { values: { key: value } }
export const onRequestPut: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'settings.manage');
  if (user instanceof Response) return user;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error('Invalid JSON body');
  }
  const parsed = settingsUpdateSchema.safeParse(body);
  if (!parsed.success) return error('Validation failed', 400, parsed.error.flatten());
  const ts = now();
  const entries = Object.entries(parsed.data.values);
  if (entries.length) {
    await env.DB.batch(
      entries.map(([key, value]) =>
        env.DB.prepare(
          `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        ).bind(key, String(value), ts, user.id),
      ),
    );
  }
  return json({ ok: true });
};
