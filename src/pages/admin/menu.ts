import type { Permission } from '@shared/permissions';

export interface AdminMenuItem {
  to: string;
  label: string;
  description: string;
  /** Hidden unless the administrator holds this permission (matches the route guard). */
  permission?: Permission;
}

export interface AdminMenuGroup {
  title: string;
  description: string;
  items: AdminMenuItem[];
}

/** Every administration page, grouped by the job it helps with. Drives the dashboard and the sidebar. */
export const ADMIN_MENU: AdminMenuGroup[] = [
  {
    title: 'Bookings',
    description: 'Day-to-day booking work.',
    items: [
      { to: '/admin/bookings', label: 'Bookings & approvals', description: 'Approve requests and changes, book for a customer, cancel.' },
      { to: '/admin/calendar', label: 'Calendar', description: 'Every booking, closure and maintenance job by day or week.' },
      { to: '/admin/agreements', label: 'Agreements', description: 'Hire terms customers accept, and who accepted them.', permission: 'bookings.view' },
      { to: '/admin/finance', label: 'Booking values', description: 'Income from bookings, with reports to export.', permission: 'finance.view' },
    ],
  },
  {
    title: 'Venue & availability',
    description: 'What can be booked, and when.',
    items: [
      { to: '/admin/resources', label: 'Resources', description: 'Add and edit halls, rooms and spaces.' },
      { to: '/admin/availability', label: 'Opening hours & rules', description: 'Weekly opening hours and regular unavailable times.' },
      { to: '/admin/availability/closures', label: 'Closed periods', description: 'One-off dates when a resource cannot be booked.' },
      { to: '/admin/availability/limits', label: 'Booking limits', description: 'Notice needed, how far ahead, provisional holds.' },
      { to: '/admin/maintenance', label: 'Maintenance & faults', description: 'Plan maintenance and record faults.', permission: 'bookings.view' },
    ],
  },
  {
    title: 'Pricing',
    description: 'What bookings cost.',
    items: [
      { to: '/admin/pricing', label: 'Prices', description: 'Base prices for each resource and category.' },
      { to: '/admin/pricing/discounts', label: 'Discounts', description: 'Discounts by resource, category or date.' },
      { to: '/admin/pricing/organisations', label: 'Organisation pricing', description: 'Special arrangements with particular organisations.' },
      { to: '/admin/pricing/categories', label: 'Pricing categories', description: 'The categories customers are priced by.' },
    ],
  },
  {
    title: 'People & access',
    description: 'Who uses the venue.',
    items: [
      { to: '/admin/users', label: 'Users', description: 'Registered customers and their accounts.' },
      { to: '/admin/organisations', label: 'Organisations', description: 'Create organisations and manage their members.' },
      { to: '/admin/assets', label: 'Keys & equipment', description: 'Keys, fobs and equipment on loan.', permission: 'assets.manage' },
      { to: '/admin/admins', label: 'Administrators', description: 'Who can use these admin pages, and their role.', permission: 'admins.manage' },
    ],
  },
  {
    title: 'Communication',
    description: 'Emails and calendar feeds.',
    items: [
      { to: '/admin/emails', label: 'Emails', description: 'Email templates and everything sent.' },
      { to: '/admin/calendar-feeds', label: 'Calendar subscriptions', description: 'Venue calendar links, and revoking shared ones.', permission: 'calendar.manage' },
    ],
  },
  {
    title: 'System',
    description: 'Site-wide settings and records.',
    items: [
      { to: '/admin/settings', label: 'Settings', description: 'Venue details, contact email and booking defaults.', permission: 'settings.manage' },
      { to: '/admin/audit', label: 'Audit history', description: 'Who changed what, and when.', permission: 'bookings.view' },
    ],
  },
];

/** The menu with the pages this administrator cannot open removed, and empty groups dropped. */
export function visibleMenu(can: (p: Permission) => boolean): AdminMenuGroup[] {
  return ADMIN_MENU
    .map((g) => ({ ...g, items: g.items.filter((i) => !i.permission || can(i.permission)) }))
    .filter((g) => g.items.length > 0);
}
