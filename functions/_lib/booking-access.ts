import type { Env } from './http';
import type { AuthUser } from './auth';
import { can } from './auth';
import { getMembershipRole } from './organisations';

export interface BookingAccess {
  canView: boolean;
  /** Cancel, request amendments: the customer, an organisation manager, or an admin with bookings.manage. */
  canManage: boolean;
  isAdminView: boolean;
}

/**
 * Who may see and manage a booking. Personal bookings: the customer. An
 * organisation booking: also every member (view) and the organisation's
 * managers (manage). Platform administrators by permission.
 */
export async function bookingAccess(
  env: Env,
  user: AuthUser,
  booking: { user_id: string; organisation_id: string | null },
): Promise<BookingAccess> {
  const isOwner = booking.user_id === user.id;
  const orgRole = booking.organisation_id ? await getMembershipRole(env, booking.organisation_id, user.id) : null;
  const adminView = can(user, 'bookings.view');
  return {
    canView: isOwner || orgRole !== null || adminView,
    canManage: isOwner || orgRole === 'manager' || can(user, 'bookings.manage'),
    isAdminView: adminView,
  };
}
