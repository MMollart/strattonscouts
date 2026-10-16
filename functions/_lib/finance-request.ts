import { error } from './http';
import type { Basis, FinanceFilters } from './finance';
import { resolvePeriod } from '@shared/finance';

/** Report filters from the query string: period (preset or from/to), basis and resource, price group or organisation. */
export function financeFiltersFromUrl(url: URL): FinanceFilters | Response {
  const q = url.searchParams;
  const period = resolvePeriod(q.get('period'), q.get('from'), q.get('to'));
  if ('error' in period) return error(period.error, 400);
  const basis = (q.get('basis') ?? 'usage') as Basis;
  if (basis !== 'usage' && basis !== 'booked') return error('basis must be usage or booked', 400);
  return {
    period,
    basis,
    resourceId: q.get('resource_id') || null,
    categoryId: q.get('category_id') || null,
    organisationId: q.get('organisation_id') || null,
  };
}
