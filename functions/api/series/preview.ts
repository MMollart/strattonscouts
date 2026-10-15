import type { Env } from '../../_lib/http';
import { error, json } from '../../_lib/http';
import { getAuthUser } from '../../_lib/auth';
import { parseBody } from '../../_lib/request';
import { previewSeries } from '../../_lib/recurring';
import { resolveSeriesRequest } from '../../_lib/series-request';
import { recurrenceSchema } from '@shared/validation';

// Review a recurring booking before submitting it (FR05 §6.4): every date,
// whether it is available and why not, and the price of the available dates.
export const onRequestPost: PagesFunction<Env> = async ({ env, request }) => {
  const user = await getAuthUser(env, request);
  if (!user) return error('Not authenticated', 401);
  const input = await parseBody(request, recurrenceSchema);
  if (input instanceof Response) return input;
  const req = await resolveSeriesRequest(env, user, input);
  if (req instanceof Response) return req;

  const preview = await previewSeries(env, req);
  if (!preview.ok) return error(preview.message, preview.code === 'resource_not_found' ? 404 : 400, { code: preview.code });
  const available = preview.occurrences.filter((o) => o.available);
  return json({
    occurrences: preview.occurrences,
    available_count: available.length,
    unavailable_count: preview.occurrences.length - available.length,
    total_pence: available.reduce((sum, o) => sum + (o.price?.total_pence ?? 0), 0),
    requires_approval: preview.requiresApproval,
  });
};
