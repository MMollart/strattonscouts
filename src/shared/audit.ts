/** Labels for the audit history (FR11), shared by the admin screens. */

export const ENTITY_TYPE_LABELS: Record<string, string> = {
  booking: 'Booking',
  resource: 'Resource',
  closure: 'Closure',
  availability_rule: 'Availability rule',
  base_rate: 'Price',
  discount: 'Discount',
  pricing_category: 'Price group',
  organisation_pricing: 'Organisation pricing',
  organisation: 'Organisation',
  organisation_membership: 'Organisation membership',
  organisation_invitation: 'Organisation invitation',
  user: 'User',
  setting: 'Setting',
  email_template: 'Email template',
  asset: 'Asset',
  asset_type: 'Asset type',
  maintenance: 'Maintenance',
  maintenance_type: 'Maintenance type',
  fault: 'Fault',
  agreement: 'Agreement',
  agreement_acceptance: 'Agreement acceptance',
  agreement_document: 'Agreement document',
  calendar_subscription: 'Calendar subscription',
};

const VERB_LABELS: Record<string, string> = {
  created: 'created',
  confirmed: 'confirmed',
  provisional: 'held provisionally',
  approved: 'approved',
  rejected: 'rejected',
  cancelled: 'cancelled',
  expired: 'expired',
  amended: 'amended',
  amendment_requested: 'change requested',
  amendment_rejected: 'change rejected',
  amendment_withdrawn: 'change withdrawn',
  expiry_changed: 'hold expiry changed',
  role_changed: 'administrator role changed',
  bootstrapped: 'first Super Admin created',
};

/** "pricing.rate_updated" -> "Pricing: rate updated"; booking events read naturally. */
export function actionLabel(action: string): string {
  const [area, verb = ''] = action.split('.');
  const v = VERB_LABELS[verb] ?? verb.replace(/_/g, ' ');
  const a = area.charAt(0).toUpperCase() + area.slice(1).replace(/_/g, ' ');
  return `${a} ${v}`;
}

export const ACTION_AREAS = [
  ['booking.', 'Bookings'],
  ['pricing.', 'Pricing'],
  ['resource.', 'Resources'],
  ['availability.', 'Availability'],
  ['maintenance.', 'Maintenance'],
  ['fault.', 'Faults'],
  ['organisation.', 'Organisations'],
  ['admin.', 'Administrators'],
  ['user.', 'Users'],
  ['asset.', 'Assets'],
  ['agreement.', 'Agreements'],
  ['calendar.', 'Calendar feeds'],
  ['settings.', 'Settings'],
  ['email_template.', 'Email templates'],
] as const;

/** A changed value for display: pence as pounds, flags as Yes/No, times in UK time. */
export function formatAuditValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'number' && (key.endsWith('_pence') || key === 'value_pence')) return `£${(value / 100).toFixed(2)}`;
  if (typeof value === 'number' && key.endsWith('_bp')) return `${value / 100}%`;
  if ((key.startsWith('is_') || key.startsWith('requires_') || key.startsWith('blocks_')) && (value === 0 || value === 1 || typeof value === 'boolean')) {
    return value ? 'Yes' : 'No';
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function fieldLabel(key: string): string {
  return key.replace(/_pence$/, '').replace(/_bp$/, '').replace(/_id$/, '').replace(/_/g, ' ');
}
