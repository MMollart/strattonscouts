import type { Env } from '../../../_lib/http';
import { requirePermission } from '../../../_lib/auth';
import { loadFinanceRows } from '../../../_lib/finance';
import { financeFiltersFromUrl } from '../../../_lib/finance-request';
import { csvResponse, pounds, toCsv } from '../../../_lib/csv';
import { recordAudit } from '../../../_lib/audit';
import { formatLondon } from '@shared/londonTime';
import { FINANCE_STATUS_LABEL } from '@shared/finance';

const SOURCE_LABEL: Record<string, string> = {
  category_rate: 'Price group rate',
  organisation_rate: 'Organisation rate',
  organisation_free: 'Free (organisation)',
  organisation_discount: 'Organisation discount',
};

// Super Admin and Booking Admin: the bookings behind the report, with the same filters, as CSV (FR10).
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'finance.export');
  if (user instanceof Response) return user;
  const filters = financeFiltersFromUrl(new URL(request.url));
  if (filters instanceof Response) return filters;
  const rows = await loadFinanceRows(env, filters);
  const uk = (iso: string) => formatLondon(iso, { dateStyle: 'short', timeStyle: 'short' });
  const body = toCsv(
    ['Booking reference', 'Status', 'Resource', 'Price group', 'Organisation', 'Starts (UK)', 'Ends (UK)', 'Booked on (UK)',
      'List price (£)', 'Discount (£)', 'Booking value (£)', `Value in period (£) by ${filters.basis === 'usage' ? 'usage date' : 'booking date'}`, 'Pricing'],
    rows.map((r) => [
      r.reference, FINANCE_STATUS_LABEL[r.status], r.resource_name, r.category_label ?? '', r.organisation_name ?? 'Personal booking',
      uk(r.starts_at), uk(r.ends_at), uk(r.created_at),
      pounds(r.base_pence), pounds(r.discount_pence), pounds(r.total_pence), pounds(r.value_pence), SOURCE_LABEL[r.source ?? ''] ?? '',
    ]),
  );
  await recordAudit(env, {
    actor: user,
    action: 'finance.exported',
    entityType: 'report',
    entityId: 'booking_values',
    entityLabel: 'Booking values',
    after: { from: filters.period.from, to: filters.period.to, basis: filters.basis, resource_id: filters.resourceId, category_id: filters.categoryId, organisation_id: filters.organisationId, rows: rows.length },
  });
  return csvResponse(`booking-values-${filters.period.from}-to-${filters.period.to}.csv`, body);
};
