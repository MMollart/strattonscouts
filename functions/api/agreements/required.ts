import type { Env } from '../../_lib/http';
import { error, json } from '../../_lib/http';
import { publicAgreement, requiredAgreements } from '../../_lib/agreements';

/**
 * The agreements a booking of these resources must accept (FR20), with the
 * text of the version now in effect. Public: agreement wording is not
 * private, and the booking form shows it before sign-in completes.
 * Query: resource_ids (comma-separated).
 */
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const ids = new URL(request.url).searchParams.get('resource_ids')?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
  if (!ids.length) return error('resource_ids is required', 400);
  if (ids.length > 10) return error('Too many resources', 400);
  return json((await requiredAgreements(env, ids)).map(publicAgreement));
};
