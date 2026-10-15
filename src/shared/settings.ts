import { z } from 'zod';

/**
 * Application settings (app_settings table), editable by Super Admins.
 * Unset keys fall back to these defaults.
 */
export interface SettingDefinition {
  key: string;
  label: string;
  type: 'text' | 'email' | 'integer';
  default: string;
  help?: string;
  min?: number;
  max?: number;
}

export const SETTING_DEFINITIONS: SettingDefinition[] = [
  { key: 'venue_name', label: 'Venue name', type: 'text', default: 'Stratton Scouts', help: 'Used in emails as {{ venue_name }}.' },
  { key: 'invitation_expiry_days', label: 'Organisation invitation expiry (days)', type: 'integer', default: '7', min: 1, max: 90 },
  { key: 'contact_email', label: 'Contact email', type: 'email', default: 'bookings@strattonscouts.example', help: 'Shown to customers in emails as {{ contact_email }}.' },
];

export function settingDefault(key: string): string | undefined {
  return SETTING_DEFINITIONS.find((d) => d.key === key)?.default;
}

function valueSchema(d: SettingDefinition): z.ZodType<string, z.ZodTypeDef, unknown> {
  if (d.type === 'integer') {
    return z
      .union([z.number(), z.string()])
      .transform((v) => Number(v))
      .pipe(z.number().int().min(d.min ?? 0).max(d.max ?? Number.MAX_SAFE_INTEGER))
      .transform(String);
  }
  if (d.type === 'email') return z.string().trim().email().max(200);
  return z.string().trim().min(1).max(200);
}

export const settingsUpdateSchema = z.object({
  values: z
    .record(z.string(), z.unknown())
    .superRefine((values, ctx) => {
      for (const key of Object.keys(values)) {
        if (!SETTING_DEFINITIONS.some((d) => d.key === key)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Unknown setting ${key}`, path: [key] });
        }
      }
    })
    .transform((values, ctx) => {
      const out: Record<string, string> = {};
      for (const [key, raw] of Object.entries(values)) {
        const def = SETTING_DEFINITIONS.find((d) => d.key === key);
        if (!def) continue;
        const parsed = valueSchema(def).safeParse(raw);
        if (!parsed.success) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid value for ${def.label}`, path: [key] });
          continue;
        }
        out[key] = parsed.data;
      }
      return out;
    }),
});
