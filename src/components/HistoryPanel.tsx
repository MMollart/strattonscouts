import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { formatLondon } from '@shared/londonTime';
import { actionLabel, fieldLabel, formatAuditValue } from '@shared/audit';

export interface AuditEventView {
  seq: number;
  id: string;
  created_at: string;
  actor_id: string | null;
  actor_type: 'customer' | 'administrator' | 'system';
  actor_name: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  entity_label: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  booking_reference: string | null;
  organisation_name: string | null;
  sealed: boolean;
}

export function actorText(e: Pick<AuditEventView, 'actor_type' | 'actor_name'>): string {
  if (e.actor_type === 'system') return 'System (automatic)';
  return `${e.actor_name ?? 'Unknown user'} (${e.actor_type})`;
}

/** The before and after values of one event, as a small table. */
export function ChangeTable({ before, after }: { before: Record<string, unknown> | null; after: Record<string, unknown> | null }) {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
  if (!keys.length) return null;
  return (
    <table className="mt-2 w-full text-left text-xs">
      <thead>
        <tr className="text-gray-500">
          <th className="py-1 pr-2 font-bold">Field</th>
          {before && <th className="py-1 pr-2 font-bold">Before</th>}
          {after && <th className="py-1 font-bold">After</th>}
        </tr>
      </thead>
      <tbody>
        {keys.map((k) => (
          <tr key={k} className="border-t border-gray-100 align-top">
            <td className="py-1 pr-2 capitalize text-gray-600">{fieldLabel(k)}</td>
            {before && <td className="py-1 pr-2 break-all">{formatAuditValue(k, before[k])}</td>}
            {after && <td className="py-1 break-all">{formatAuditValue(k, after[k])}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * A record's own history (FR11 §6.5): pass the audit filters that select it,
 * for example { booking_id } or { entity_type: 'resource', entity_id }.
 */
export function HistoryPanel({ filters, title = 'History' }: { filters: Record<string, string>; title?: string }) {
  const [events, setEvents] = useState<AuditEventView[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const query = new URLSearchParams(filters).toString();

  async function load(before?: number) {
    try {
      const res = await api.get<{ events: AuditEventView[]; next_before: number | null }>(`/admin/audit?${query}&limit=25${before ? `&before=${before}` : ''}`);
      setEvents((prev) => (before && prev ? [...prev, ...res.events] : res.events));
      setNext(res.next_before);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load the history');
    }
  }

  useEffect(() => {
    if (open) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query]);

  return (
    <section className="card mt-6">
      <button className="flex w-full items-center justify-between text-left" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <h2 className="text-xl">{title}</h2>
        <span className="text-sm font-bold text-scout-purple">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="mt-3">
          {error && <p className="text-sm text-scout-red">{error}</p>}
          {events && events.length === 0 && <p className="text-sm text-gray-500">No recorded changes yet.</p>}
          <ol className="space-y-3">
            {events?.map((e) => (
              <li key={e.id} className="border-l-4 border-scout-purple/30 pl-3">
                <p className="font-bold">{actionLabel(e.action)}</p>
                <p className="text-xs text-gray-600">
                  {formatLondon(e.created_at)} · {actorText(e)}
                </p>
                {e.reason && <p className="mt-1 text-sm">Reason: {e.reason}</p>}
                <ChangeTable before={e.before} after={e.after} />
              </li>
            ))}
          </ol>
          {next && (
            <button className="btn-secondary mt-3 text-sm" onClick={() => void load(next)}>
              Show older
            </button>
          )}
        </div>
      )}
    </section>
  );
}
