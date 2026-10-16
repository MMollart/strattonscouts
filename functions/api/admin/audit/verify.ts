import type { Env } from '../../../_lib/http';
import { json } from '../../../_lib/http';
import { requirePermission } from '../../../_lib/auth';
import { sealAuditEvents, verifyAuditChain } from '../../../_lib/audit';

// Admin: seal new events, then recompute the hash chain over the whole log.
export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'audit.view');
  if (user instanceof Response) return user;
  while ((await sealAuditEvents(env)) > 0) {
    // keep sealing until nothing is left
  }
  return json(await verifyAuditChain(env));
};
