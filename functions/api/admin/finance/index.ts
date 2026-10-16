import type { Env } from '../../../_lib/http';
import { json } from '../../../_lib/http';
import { requirePermission } from '../../../_lib/auth';
import { loadFinanceRows, summarise } from '../../../_lib/finance';
import { financeFiltersFromUrl } from '../../../_lib/finance-request';

/**
 * Admin: booking value report (FR10). Query: period (this_month, last_month,
 * this_year, last_year, custom with from/to as UK dates), basis (usage, the
 * default, or booked), resource_id, category_id, organisation_id ("none" for
 * personal bookings). Booking values, not payments received.
 */
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'finance.view');
  if (user instanceof Response) return user;
  const filters = financeFiltersFromUrl(new URL(request.url));
  if (filters instanceof Response) return filters;
  const rows = await loadFinanceRows(env, filters);
  return json({
    period: filters.period,
    basis: filters.basis,
    currency: 'GBP',
    note: 'Booking values from the price stored on each booking. These are not payments received.',
    ...summarise(rows, filters.period),
  });
};
