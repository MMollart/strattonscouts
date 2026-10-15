import type { Env } from './http';
import type { OrganisationArrangement } from '@shared/pricing';

/**
 * The organisation-specific pricing arrangement for a resource at a time, if
 * any. Organisation-specific pricing is added by FR14; until then there are
 * no arrangements.
 */
export async function loadOrganisationArrangement(
  _env: Env,
  _args: { organisationId: string; resourceId: string; at: string },
): Promise<OrganisationArrangement | null> {
  return null;
}
