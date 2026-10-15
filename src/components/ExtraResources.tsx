import { useEffect } from 'react';
import { useApi } from '../lib/useApi';
import { useAvailability } from './BookingWindowFields';
import { useQuote } from '../lib/useQuote';
import { formatGBP } from '@shared/pricing';
import { blockedMessage, hierarchyRelation } from '@shared/hierarchy';

interface ResourceOpt {
  id: string;
  name: string;
  requires_approval: boolean;
  /** Every resource this one is part of, nearest first. */
  ancestor_ids: string[];
}

export interface ExtraStatus {
  ok: boolean;
  totalPence: number | null;
}

const UNAVAILABLE = ['conflict', 'closure', 'inactive', 'restricted'];

/**
 * Pick more resources to book for the same time (for example the Kitchen with
 * the Main Hall). Each one is checked and priced live; the parent sends them
 * as additional_resource_ids and the server books all of them or none.
 */
export function ExtraResources({
  mainResourceId,
  window,
  organisationId,
  selected,
  onChange,
  onStatus,
}: {
  mainResourceId: string;
  window: { startsAt: string; endsAt: string } | null;
  organisationId: string | null;
  selected: string[];
  onChange: (ids: string[]) => void;
  onStatus: (id: string, status: ExtraStatus | null) => void;
}) {
  const { data: resources } = useApi<ResourceOpt[]>('/resources');
  const others = (resources ?? []).filter((r) => r.id !== mainResourceId);
  if (!others.length) return null;

  const byId = new Map((resources ?? []).map((r) => [r.id, r]));
  const ancestorsOf = (id: string) => byId.get(id)?.ancestor_ids ?? [];
  const nameOf = (id: string) => byId.get(id)?.name ?? 'another resource';

  // A resource cannot be added alongside one it is part of, or one that is
  // part of it: the parent already covers the child, so it would be charged
  // twice. Siblings (two halls) are fine.
  const clashFor = (id: string): string | null => {
    for (const other of [mainResourceId, ...selected]) {
      if (other === id) continue;
      const relation = hierarchyRelation(id, other, ancestorsOf);
      if (relation === 'parent') return `Already included in ${nameOf(other)}, which you are booking.`;
      if (relation === 'child') return `Includes ${nameOf(other)}, which you are booking. Book one or the other.`;
    }
    return null;
  };

  const toggle = (id: string) => {
    if (selected.includes(id)) {
      onChange(selected.filter((x) => x !== id));
      onStatus(id, null);
    } else onChange([...selected, id]);
  };

  return (
    <fieldset className="rounded-xl border p-4">
      <legend className="px-1 font-bold">Add more resources at the same time</legend>
      <p className="text-sm text-gray-600">They are booked together: if any one is unavailable, nothing is booked.</p>
      <ul className="mt-3 space-y-2">
        {others.map((r) => {
          const clash = clashFor(r.id);
          const blocked = !!clash && !selected.includes(r.id);
          return (
          <li key={r.id}>
            <label className={`flex items-start gap-2 ${blocked ? 'text-gray-500' : ''}`}>
              <input
                type="checkbox"
                className="mt-1"
                checked={selected.includes(r.id)}
                disabled={blocked}
                aria-describedby={clash ? `extra-clash-${r.id}` : undefined}
                onChange={() => toggle(r.id)}
              />
              <span className="grow">
                <span className="font-bold">{r.name}</span>
                {r.requires_approval && <span className="ml-1 text-xs text-yellow-800">needs approval</span>}
                {clash && (
                  <span id={`extra-clash-${r.id}`} className={`block text-sm ${selected.includes(r.id) ? 'text-scout-red' : 'text-gray-600'}`}>
                    {clash}
                  </span>
                )}
                {selected.includes(r.id) && (
                  <ExtraLine resourceId={r.id} window={window} organisationId={organisationId} clash={!!clash} onStatus={(s) => onStatus(r.id, s)} />
                )}
              </span>
            </label>
          </li>
          );
        })}
      </ul>
    </fieldset>
  );
}

function ExtraLine({
  resourceId,
  window,
  organisationId,
  clash,
  onStatus,
}: {
  resourceId: string;
  window: { startsAt: string; endsAt: string } | null;
  organisationId: string | null;
  /** Picked together with a parent or child of itself, so it cannot be booked. */
  clash: boolean;
  onStatus: (s: ExtraStatus) => void;
}) {
  const availability = useAvailability(resourceId, window);
  const { quote, loading, error } = useQuote({ resourceId, window, organisationId });
  const unavailable = clash || UNAVAILABLE.includes(availability.status);
  const ok = !unavailable && availability.status === 'available' && !!quote;

  useEffect(() => {
    onStatus({ ok, totalPence: quote?.total_pence ?? null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ok, quote?.total_pence]);

  let text: string;
  if (clash) text = '';
  else if (availability.status === 'checking' || loading) text = 'Checking…';
  else if (availability.status === 'conflict') text = capitalise(blockedMessage('booked', availability.blockedBy));
  else if (availability.status === 'closure') text = capitalise(blockedMessage('closed', availability.blockedBy));
  else if (availability.status === 'inactive') text = 'Not available to book';
  else if (availability.status === 'restricted') text = availability.violations[0]?.message ?? 'Not bookable at this time';
  else if (error) text = error;
  else text = quote ? formatGBP(quote.total_pence) : '';
  return <span className={`block text-sm ${unavailable || error ? 'text-scout-red' : 'text-gray-700'}`}>{text}</span>;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
