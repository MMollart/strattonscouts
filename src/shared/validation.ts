import { z } from 'zod';
import { ADMIN_ROLES } from './permissions';

export const categoryNameSchema = z.enum(['scouts', 'community', 'public']);
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
