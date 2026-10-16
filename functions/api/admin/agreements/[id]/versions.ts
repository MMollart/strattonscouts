import type { Env } from '../../../../_lib/http';
import { requirePermission } from '../../../../_lib/auth';
import { publishVersion } from '../../../../_lib/agreement-admin';

// Admin: publish a new version of an agreement, optionally with a PDF.
export const onRequestPost: PagesFunction<Env> = async ({ env, request, params }) => {
  const user = await requirePermission(env, request, 'agreements.manage');
  if (user instanceof Response) return user;
  return publishVersion(env, user, String(params.id), request);
};
