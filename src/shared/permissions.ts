/**
 * Administration roles and permissions (Release 2 / FR08).
 *
 * The authoritative role-to-permission mapping lives in the database
 * (role_permissions, seeded by migration 0003) and is enforced server-side.
 * These constants give both the frontend and backend one vocabulary.
 */

export const ADMIN_ROLES = ['super_admin', 'booking_admin', 'viewer'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export const ADMIN_ROLE_LABELS: Record<AdminRole, string> = {
  super_admin: 'Super Admin',
  booking_admin: 'Booking Admin',
  viewer: 'Viewer',
};

export const PERMISSIONS = [
  'bookings.view',
  'bookings.create',
  'bookings.approve',
  'bookings.manage',
  'availability.manage',
  'resources.manage',
  'pricing.manage',
  'assets.manage',
  'email_templates.manage',
  'finance.view',
  'admins.manage',
  'settings.manage',
  'audit.view',
  'audit.export',
  'maintenance.manage',
  'agreements.manage',
  'finance.export',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export function isAdminRole(role: string): role is AdminRole {
  return (ADMIN_ROLES as readonly string[]).includes(role);
}
