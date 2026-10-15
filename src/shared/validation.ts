import { z } from 'zod';
import { ADMIN_ROLES } from './permissions';

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

export const createBookingSchema = z
  .object({
    resource_id: z.string().min(1),
    starts_at: isoDateTime,
    ends_at: isoDateTime,
    // admin-only: create on behalf of a customer
    on_behalf_of_user_id: z.string().min(1).optional(),
    // book on behalf of an organisation the customer belongs to (FR01)
    organisation_id: z.string().min(1).nullable().optional(),
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
  resource_type: z.enum(['individual', 'combined']).default('individual'),
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

export const conflictUpsertSchema = z.object({
  resource_id: z.string().min(1),
  conflicts_with_id: z.string().min(1),
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
