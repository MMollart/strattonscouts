import type { Env } from './http';
import type { OrganisationArrangement } from '@shared/pricing';

export interface OrganisationPricingRow {
  id: string;
  organisation_id: string;
  resource_id: string | null;
  arrangement_type: 'rate' | 'free' | 'percentage' | 'fixed_discount';
  pricing_model: 'hourly' | 'nightly' | 'fixed' | null;
  value: number;
  effective_from: string;
  effective_to: string | null;
  is_active: number;
  notes: string | null;
}

/** Customer-facing label for an arrangement, e.g. "Organisation discount (20%)". */
function label(row: OrganisationPricingRow): string {
  if (row.arrangement_type === 'free') return 'Organisation arrangement: free use';
  if (row.arrangement_type === 'rate') return 'Organisation rate';
  if (row.arrangement_type === 'percentage') return `Organisation discount (${Number((row.value / 100).toFixed(2))}%)`;
  return 'Organisation discount';
}

export function toArrangement(row: OrganisationPricingRow): OrganisationArrangement {
  const l = label(row);
  if (row.arrangement_type === 'rate') {
    return { id: row.id, kind: 'rate', label: l, rate: { id: row.id, pricing_model: row.pricing_model ?? 'hourly', amount_pence: row.value } };
  }
  if (row.arrangement_type === 'free') return { id: row.id, kind: 'free', label: l };
  return {
    id: row.id,
    kind: 'discount',
    label: l,
    discount: { id: row.id, label: l, discount_type: row.arrangement_type === 'percentage' ? 'percentage' : 'fixed', value: row.value },
  };
}

/**
 * The single organisation arrangement that applies to a resource at a time
 * (FR14 §12.3): a resource-specific rate or free use first, then a
 * resource-specific discount, then an all-resources discount. Within each,
 * the newest effective arrangement wins. Arrangements never stack.
 */
export async function loadOrganisationArrangement(
  env: Env,
  args: { organisationId: string; resourceId: string; at: string },
): Promise<OrganisationArrangement | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM organisation_pricing
     WHERE organisation_id = ? AND is_active = 1 AND (resource_id = ? OR resource_id IS NULL)
       AND effective_from <= ? AND (effective_to IS NULL OR effective_to > ?)
     ORDER BY CASE
                WHEN resource_id IS NOT NULL AND arrangement_type IN ('rate', 'free') THEN 0
                WHEN resource_id IS NOT NULL THEN 1
                ELSE 2
              END,
              effective_from DESC, updated_at DESC
     LIMIT 1`,
  )
    .bind(args.organisationId, args.resourceId, args.at, args.at)
    .first<OrganisationPricingRow>();
  return row ? toArrangement(row) : null;
}

/**
 * Another active arrangement for the same organisation and resource scope
 * whose period overlaps. Used to keep one arrangement per resource and period
 * (rates/free use and discounts are checked separately, since a
 * resource-specific rate legitimately coexists with an all-resources discount).
 */
export async function findOverlappingArrangement(
  env: Env,
  args: { organisationId: string; resourceId: string | null; type: OrganisationPricingRow['arrangement_type']; from: string; to: string | null; excludeId?: string },
): Promise<boolean> {
  const isRate = args.type === 'rate' || args.type === 'free';
  const row = await env.DB.prepare(
    `SELECT 1 FROM organisation_pricing
     WHERE organisation_id = ? AND is_active = 1 AND id <> ?
       AND ((? IS NULL AND resource_id IS NULL) OR resource_id = ?)
       AND (arrangement_type IN ('rate', 'free')) = ?
       AND (effective_to IS NULL OR effective_to > ?)
       AND (? IS NULL OR effective_from < ?)
     LIMIT 1`,
  )
    .bind(args.organisationId, args.excludeId ?? '', args.resourceId, args.resourceId, isRate ? 1 : 0, args.from, args.to, args.to)
    .first();
  return !!row;
}
