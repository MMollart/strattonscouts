// Shared domain types used by both frontend and backend (Pages Functions).
import type { AdminRole, Permission } from './permissions';

export type PricingModel = 'hourly' | 'nightly' | 'fixed';
export type ResourceType = 'individual' | 'combined';

// Release 1 statuses. Schema permits future: provisional, expired, completed.
export type BookingStatus =
  | 'pending_approval'
  | 'confirmed'
  | 'rejected'
  | 'cancelled';

export type { AdminRole as RoleName } from './permissions';

export type CategoryName = string;

export interface PricingCategory {
  id: string;
  name: CategoryName;
  label: string;
  sort_order: number;
}

export interface PublicUser {
  id: string;
  email: string;
  full_name: string;
  phone: string | null;
  pricing_category_id: string;
  roles: AdminRole[];
  permissions: Permission[];
}

export interface Resource {
  id: string;
  name: string;
  slug: string;
  description: string;
  resource_type: ResourceType;
  is_active: boolean;
  requires_approval: boolean;
  pricing_model: PricingModel;
  created_at: string;
  updated_at: string;
}

export interface ResourceImage {
  id: string;
  resource_id: string;
  r2_key: string;
  content_type: string;
  size_bytes: number;
  is_primary: boolean;
}

export interface ResourcePrice {
  id: string;
  resource_id: string;
  category_id: string;
  amount_pence: number;
  is_free: boolean;
}

export interface ResourceConflict {
  id: string;
  resource_id: string;
  conflicts_with_id: string;
  is_mandatory: boolean;
}

export interface Booking {
  id: string;
  reference: string;
  user_id: string;
  resource_id: string;
  starts_at: string;
  ends_at: string;
  status: BookingStatus;
  category_id: string;
  pricing_model: PricingModel;
  unit_price_pence: number;
  total_amount_pence: number;
  approved_by: string | null;
  cancelled_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApiError {
  error: string;
  details?: unknown;
}
