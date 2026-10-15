import type { Env } from './http';
import { settingDefault } from '@shared/settings';

/** Read an application setting, falling back to its default. */
export async function getSetting(env: Env, key: string): Promise<string> {
  const row = await env.DB.prepare('SELECT value FROM app_settings WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? settingDefault(key) ?? '';
}

/** Read an integer setting, falling back to its default (or `fallback`). */
export async function getIntSetting(env: Env, key: string, fallback: number): Promise<number> {
  const n = Number(await getSetting(env, key));
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : fallback;
}
