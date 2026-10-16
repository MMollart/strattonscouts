import { z } from 'zod';

/**
 * Application settings (app_settings table), editable by Super Admins.
 * Unset keys fall back to these defaults.
 */
export interface SettingDefinition {
  key: string;
  label: string;
  type: 'text' | 'email' | 'integer' | 'url';
  default: string;
  help?: string;
  min?: number;
  max?: number;
  /** May be left blank. */
  optional?: boolean;
}

export const SETTING_DEFINITIONS: SettingDefinition[] = [
  { key: 'venue_name', label: 'Venue name', type: 'text', default: 'Stratton Scouts', help: 'Used in emails as {{ venue_name }}.' },
  { key: 'invitation_expiry_days', label: 'Organisation invitation expiry (days)', type: 'integer', default: '7', min: 1, max: 90 },
  {
    key: 'provisional_expiry_hours', label: 'Provisional booking hold (hours)', type: 'integer', default: '48', min: 1, max: 720,
    help: 'How long a provisional booking holds its resource unless the resource sets its own period.',
  },
  {
    key: 'payment_instructions', label: 'Payment instructions', type: 'text',
    default: 'Please pay by bank transfer. Contact us for the account details.',
    help: 'Used in payment reminder emails as {{ payment_instructions }}.',
  },
  { key: 'contact_email', label: 'Contact email', type: 'email', default: 'bookings@strattonscouts.example', help: 'Shown to customers in emails as {{ contact_email }}.' },
  {
    key: 'email_logo_url', label: 'Email logo URL', type: 'url', default: '', optional: true,
    help: 'Public https address of the logo shown at the top of every email and in the site header (for example on R2). Leave blank to show the initials in the header and no logo in emails.',
  },
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
  if (d.type === 'url') return z.string().trim().max(500).refine((v) => v === '' || /^https:\/\/\S+$/.test(v), 'Must start with https://');
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
