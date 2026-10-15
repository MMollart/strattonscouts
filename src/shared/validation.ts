import { z } from 'zod';
import { ADMIN_ROLES } from './permissions';
import { ASSET_SETTABLE_STATUSES } from './assets';

// Categories are configurable (FR02); names are validated against the database.
export const categoryNameSchema = z.string().trim().min(1).max(40);
export const pricingModelSchema = z.enum(['hourly', 'nightly', 'fixed']);

// ISO-8601 datetime string
const isoDateTime = z.string().datetime({ offset: true }).or(z.string().datetime());

export const registerSchema = z.object({
  full_name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(200),
  phone: z.string().trim().min(5).max(40),
  password: z.string().min(10).max(200),
  category: categoryNameSchema,
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const updateAccountSchema = z.object({
  full_name: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(5).max(40),
});
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;

export const passwordResetRequestSchema = z.object({
  email: z.string().trim().email(),
});

export const passwordResetConfirmSchema = z.object({
  token: z.string().min(10),
  password: z.string().min(10).max(200),
});

export const overrideSchema = z.object({
  kinds: z.array(z.enum(['min_notice', 'max_advance', 'opening_hours', 'recurring_restriction'])).min(1),
  reason: z.string().trim().min(3).max(500),
});

export const createBookingSchema = z
  .object({
    resource_id: z.string().min(1),
    // more resources to book for the same time, all or nothing
    additional_resource_ids: z.array(z.string().min(1)).max(9).optional(),
    starts_at: isoDateTime,
    ends_at: isoDateTime,
    // admin-only: create on behalf of a customer
    on_behalf_of_user_id: z.string().min(1).optional(),
    // book on behalf of an organisation the customer belongs to (FR01)
    organisation_id: z.string().min(1).nullable().optional(),
    // admin-only: override restrictions with a recorded reason (FR03)
    override: overrideSchema.nullable().optional(),
    // hold the resource provisionally until it is confirmed or expires (FR04)
    provisional: z.boolean().optional(),
    // admin-only: hold period for this booking instead of the resource default
    provisional_expiry_hours: z.number().int().min(1).max(720).nullable().optional(),
  })
  .refine((v) => new Date(v.ends_at).getTime() > new Date(v.starts_at).getTime(), {
    message: 'End time must be after start time',
    path: ['ends_at'],
  });
export type CreateBookingInput = z.infer<typeof createBookingSchema>;

export const resourceUpsertSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens')
    .max(120),
  description: z.string().max(5000).default(''),
  /** The resource this one is part of (Main Hall is part of Indoor); null at the top. */
  parent_id: z.string().min(1).nullable().default(null),
  is_active: z.boolean().default(true),
  requires_approval: z.boolean().default(false),
  pricing_model: pricingModelSchema.default('hourly'),
});
export type ResourceUpsertInput = z.infer<typeof resourceUpsertSchema>;

export const pricingUpsertSchema = z.object({
  category_id: z.string().min(1),
  amount_pence: z.number().int().min(0),
  is_free: z.boolean().default(false),
});

export const closureSchema = z
  .object({
    resource_id: z.string().min(1),
    starts_at: isoDateTime,
    ends_at: isoDateTime,
    reason: z.string().max(500).optional(),
  })
  .refine((v) => new Date(v.ends_at).getTime() > new Date(v.starts_at).getTime(), {
    message: 'End must be after start',
    path: ['ends_at'],
  });

export const adminUserUpdateSchema = z.object({
  pricing_category_id: z.string().min(1),
});

export const adminRoleUpdateSchema = z.object({
  role: z.enum(ADMIN_ROLES).nullable(),
});

// ------------------------- Organisations (FR01) ---------------------------
export const organisationRoleSchema = z.enum(['manager', 'member']);
export type OrganisationRole = z.infer<typeof organisationRoleSchema>;

export const organisationSchema = z.object({
  name: z.string().trim().min(2).max(120),
  organisation_type_id: z.string().min(1),
  pricing_category_id: z.string().min(1),
  contact_email: z.string().trim().email().max(200),
  contact_phone: z.string().trim().min(5).max(40),
});
export type OrganisationInput = z.infer<typeof organisationSchema>;

export const invitationCreateSchema = z.object({
  email: z.string().trim().email().max(200),
  role: organisationRoleSchema.default('member'),
});

export const invitationResponseSchema = z.object({
  action: z.enum(['accept', 'decline']),
});

export const membershipUpdateSchema = z.object({
  role: organisationRoleSchema,
});

// ------------------------- Pricing (FR02 / FR14) --------------------------
const optionalIso = isoDateTime.nullable().optional();

function effectiveRange<T extends { effective_from: string; effective_to?: string | null }>(v: T): boolean {
  return !v.effective_to || new Date(v.effective_to).getTime() > new Date(v.effective_from).getTime();
}

export const rateModelSchema = z.enum(['hourly', 'nightly', 'fixed', 'free']);

export const pricingRateSchema = z
  .object({
    resource_id: z.string().min(1),
    category_id: z.string().min(1),
    pricing_model: rateModelSchema,
    amount_pence: z.number().int().min(0).max(100_000_000),
    effective_from: isoDateTime,
    effective_to: optionalIso,
    is_active: z.boolean().default(true),
  })
  .refine(effectiveRange, { message: 'Effective to must be after effective from', path: ['effective_to'] });

export const discountSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    discount_type: z.enum(['percentage', 'fixed']),
    // basis points for percentage (max 100%), pence for fixed
    value: z.number().int().min(0).max(100_000_000),
    resource_id: z.string().min(1).nullable().optional(),
    category_id: z.string().min(1).nullable().optional(),
    effective_from: isoDateTime,
    effective_to: optionalIso,
    is_active: z.boolean().default(true),
  })
  .refine(effectiveRange, { message: 'Effective to must be after effective from', path: ['effective_to'] })
  .refine((v) => v.discount_type !== 'percentage' || v.value <= 10_000, { message: 'A percentage cannot exceed 100%', path: ['value'] });

export const categoryCreateSchema = z.object({
  name: z.string().trim().regex(/^[a-z0-9_]+$/, 'Use lowercase letters, numbers and underscores').min(2).max(40),
  label: z.string().trim().min(2).max(120),
  sort_order: z.number().int().min(0).max(1000).default(100),
  is_active: z.boolean().default(true),
});

export const quoteSchema = z
  .object({
    resource_id: z.string().min(1),
    starts_at: isoDateTime,
    ends_at: isoDateTime,
    organisation_id: z.string().min(1).nullable().optional(),
    on_behalf_of_user_id: z.string().min(1).optional(),
  })
  .refine((v) => new Date(v.ends_at).getTime() > new Date(v.starts_at).getTime(), {
    message: 'End time must be after start time',
    path: ['ends_at'],
  });

export const organisationPricingSchema = z
  .object({
    organisation_id: z.string().min(1),
    resource_id: z.string().min(1).nullable().optional(),
    arrangement_type: z.enum(['rate', 'free', 'percentage', 'fixed_discount']),
    pricing_model: z.enum(['hourly', 'nightly', 'fixed']).nullable().optional(),
    value: z.number().int().min(0).max(100_000_000).default(0),
    effective_from: isoDateTime,
    effective_to: optionalIso,
    is_active: z.boolean().default(true),
    notes: z.string().max(500).nullable().optional(),
  })
  .refine(effectiveRange, { message: 'Effective to must be after effective from', path: ['effective_to'] })
  .refine((v) => !(v.arrangement_type === 'rate' || v.arrangement_type === 'free') || !!v.resource_id, {
    message: 'A rate or free use applies to one resource',
    path: ['resource_id'],
  })
  .refine((v) => v.arrangement_type !== 'rate' || !!v.pricing_model, { message: 'Choose how the rate is charged', path: ['pricing_model'] })
  .refine((v) => v.arrangement_type !== 'percentage' || v.value <= 10_000, { message: 'A percentage cannot exceed 100%', path: ['value'] });

// ------------------------- Availability rules (FR03) ----------------------
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm');
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const availabilityRuleSchema = z
  .object({
    resource_id: z.string().min(1),
    rule_type: z.enum(['closed', 'open']),
    days_of_week: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    start_time: hhmm,
    end_time: hhmm,
    valid_from: ymd.nullable().optional(),
    valid_to: ymd.nullable().optional(),
    label: z.string().trim().max(120).nullable().optional(),
    is_active: z.boolean().default(true),
  })
  .refine((v) => !v.valid_from || !v.valid_to || v.valid_to >= v.valid_from, { message: 'The season must end after it starts', path: ['valid_to'] });

export const restrictionsSchema = z.object({
  min_notice_minutes: z.number().int().min(0).max(525_600).nullable(),
  max_advance_days: z.number().int().min(1).max(3650).nullable(),
  // FR04: blank uses the global provisional_expiry_hours setting
  provisional_expiry_hours: z.number().int().min(1).max(720).nullable().optional(),
});

export const bookingExpirySchema = z.object({ expires_at: isoDateTime });

// FR05 recurring bookings
const recurrenceFields = {
  resource_id: z.string().min(1),
  organisation_id: z.string().min(1).nullable().optional(),
  on_behalf_of_user_id: z.string().min(1).optional(),
  frequency: z.enum(['daily', 'weekly', 'fortnightly', 'monthly']),
  monthly_mode: z.enum(['day_of_month', 'nth_weekday']).default('day_of_month'),
  start_date: ymd,
  start_time: hhmm,
  end_time: hhmm,
  until_date: ymd.nullable().optional(),
  count: z.number().int().min(2).max(104).nullable().optional(),
};

const recurrenceRefinements = <T extends z.ZodTypeAny>(schema: T) =>
  schema
    .refine((v: { until_date?: string | null; count?: number | null }) => !!v.until_date || !!v.count, {
      message: 'Choose an end date or a number of occurrences',
      path: ['until_date'],
    })
    .refine((v: { until_date?: string | null; start_date: string }) => !v.until_date || v.until_date >= v.start_date, {
      message: 'The end date must be on or after the start date',
      path: ['until_date'],
    })
    .refine((v: { start_time: string; end_time: string }) => v.start_time !== v.end_time, {
      message: 'The end time must differ from the start time',
      path: ['end_time'],
    });

export const recurrenceSchema = recurrenceRefinements(z.object(recurrenceFields));
export const seriesCreateSchema = recurrenceRefinements(
  z.object({
    ...recurrenceFields,
    // Dates the customer chose to leave out, e.g. because they clash (§6.4).
    exclude_dates: z.array(ymd).max(104).default([]),
  }),
);
export type RecurrenceInput = z.infer<typeof recurrenceSchema>;

export const seriesCancelSchema = z.object({
  scope: z.enum(['all', 'future']),
  // 'future': this occurrence and every later one
  from_booking_id: z.string().min(1).optional(),
});

export const seriesAmendSchema = z.object({
  scope: z.enum(['one', 'future']),
  booking_id: z.string().min(1),
  start_time: hhmm,
  end_time: hhmm,
  resource_id: z.string().min(1).optional(),
  override: overrideSchema.nullable().optional(),
});

// FR12 customer booking amendments
export const amendmentRequestSchema = z
  .object({
    resource_id: z.string().min(1),
    starts_at: isoDateTime,
    ends_at: isoDateTime,
    note: z.string().trim().max(1000).nullable().optional(),
  })
  .refine((v) => new Date(v.ends_at).getTime() > new Date(v.starts_at).getTime(), {
    message: 'End time must be after start time',
    path: ['ends_at'],
  });

export const amendmentDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  note: z.string().trim().max(1000).nullable().optional(),
});

// FR06 email templates
export const emailTemplateSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  body_text: z.string().trim().min(1).max(20_000),
  body_html: z.string().trim().max(50_000).nullable().optional(),
  is_enabled: z.boolean().default(true),
});

export const emailTestSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  body_text: z.string().trim().min(1).max(20_000),
  body_html: z.string().trim().max(50_000).nullable().optional(),
});

// FR07: physical assets.
const optionalText = (max: number) =>
  z.string().trim().max(max).nullish().transform((v) => (v ? v : null));

export const assetTypeSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: optionalText(300),
  sort_order: z.number().int().min(0).max(10_000).default(0),
  is_active: z.boolean().default(true),
});

export const assetSchema = z.object({
  asset_type_id: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  description: optionalText(1000),
  reference: optionalText(80),
});

export const assetUpdateSchema = assetSchema.extend({
  status: z.enum(ASSET_SETTABLE_STATUSES).optional(),
});

export const assetAssignSchema = z.object({
  user_id: z.string().min(1),
  notes: optionalText(1000),
});

export const assetReturnSchema = z.object({
  outcome: z.enum(['available', 'damaged', 'lost']).default('available'),
  notes: optionalText(1000),
});
