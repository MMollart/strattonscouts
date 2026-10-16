import type { Env } from '../../../_lib/http';
import { requirePermission } from '../../../_lib/auth';
import { sealAuditEvents } from '../../../_lib/audit';
import { filtersFromUrl, searchAudit, type AuditRowView } from '../../../_lib/audit-query';
import { csvResponse, toCsv } from '../../../_lib/csv';
import { formatLondon, londonToday } from '@shared/londonTime';

const MAX_ROWS = 50_000;

// Super Admin: the filtered audit history as CSV (FR11 §6.9).
export const onRequestGet: PagesFunction<Env> = async ({ env, request }) => {
  const user = await requirePermission(env, request, 'audit.export');
  if (user instanceof Response) return user;
  await sealAuditEvents(env);
  const filters = filtersFromUrl(new URL(request.url));
  const rows: AuditRowView[] = [];
  let before: number | null = null;
  while (rows.length < MAX_ROWS) {
    const page = await searchAudit(env, filters, { access: 'full', beforeSeq: before, limit: 1000 });
    rows.push(...page);
    if (page.length < 1000) break;
    before = page[page.length - 1].seq;
  }
  const json = (v: unknown) => (v ? JSON.stringify(v) : '');
  const body = toCsv(
    ['Event ID', 'Sequence', 'Timestamp (UTC)', 'Timestamp (UK)', 'Actor ID', 'Actor', 'Actor type', 'Action', 'Record type', 'Record ID', 'Record',
      'Booking reference', 'Organisation ID', 'Organisation', 'Resource ID', 'Previous values', 'New values', 'Reason', 'Sealed'],
    rows.map((r) => [
      r.id, r.seq, r.created_at, formatLondon(r.created_at, { dateStyle: 'short', timeStyle: 'medium' }), r.actor_id, r.actor_name ?? (r.actor_type === 'system' ? 'System' : ''),
      r.actor_type, r.action, r.entity_type, r.entity_id, r.entity_label, r.booking_reference, r.organisation_id, r.organisation_name, r.resource_id,
      json(r.before), json(r.after), r.reason, r.sealed,
    ]),
  );
  return csvResponse(`audit-history-${londonToday()}.csv`, body);
};
