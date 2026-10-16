import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { formatLondon } from '@shared/londonTime';

export interface CalendarFeed {
  id: string;
  kind: 'user' | 'organisation' | 'admin';
  name: string;
  owner_id: string;
  owner_name: string | null;
  organisation_id: string | null;
  organisation_name: string | null;
  resource_ids: string[] | null;
  show_names: boolean;
  token_hint: string;
  created_at: string;
  regenerated_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

/** The secret URL, shown once after it is created or replaced. */
export function NewFeedUrl({ url, onDone }: { url: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const webcal = url.replace(/^https?:/, 'webcal:');
  const google = `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`;
  return (
    <div className="space-y-3 rounded-xl border-2 border-scout-green/40 bg-scout-green/5 p-4" role="status">
      <p className="font-bold">Your calendar link is ready. Copy it now: for your security it won’t be shown again.</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input className="input font-mono text-xs" readOnly value={url} aria-label="Calendar subscription link" onFocus={(e) => e.target.select()} />
        <button
          type="button"
          className="btn-primary shrink-0"
          onClick={() => navigator.clipboard?.writeText(url).then(() => setCopied(true), () => setCopied(false))}
        >
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        <a className="btn-secondary" href={webcal}>Open in calendar app</a>
        <a className="btn-secondary" href={google} target="_blank" rel="noopener noreferrer">Add to Google Calendar</a>
      </div>
      <p className="text-sm text-gray-600">
        In Outlook, choose <strong>Add calendar</strong>, then <strong>Subscribe from web</strong>, and paste the link. Anyone with this link
        can see the bookings in it, so treat it like a password. Calendar apps check for changes on their own schedule, often every few hours.
      </p>
      <button type="button" className="text-sm font-bold text-scout-purple" onClick={onDone}>Done</button>
    </div>
  );
}

/** A list of calendar links with Replace and Revoke. */
export function FeedList({ feeds, onChanged, showOwner }: { feeds: CalendarFeed[]; onChanged: () => void; showOwner?: boolean }) {
  const [newUrl, setNewUrl] = useState<{ id: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function regenerate(f: CalendarFeed) {
    if (!window.confirm(`Replace the link for “${f.name}”? The current link will stop working, and any calendar using it will need the new one.`)) return;
    setBusy(f.id);
    setError(null);
    try {
      const r = await api.post<{ url: string }>(`/calendar-feeds/${f.id}/regenerate`, {});
      setNewUrl({ id: f.id, url: r.url });
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not replace the link');
    } finally {
      setBusy(null);
    }
  }
  async function revoke(f: CalendarFeed) {
    if (!window.confirm(`Revoke “${f.name}”? The link will stop working and calendars using it will stop updating.`)) return;
    setBusy(f.id);
    setError(null);
    try {
      await api.del(`/calendar-feeds/${f.id}`);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not revoke the link');
    } finally {
      setBusy(null);
    }
  }

  if (!feeds.length) return <p className="text-sm text-gray-600">No calendar links yet.</p>;
  return (
    <div className="space-y-3">
      {error && <p className="text-sm font-bold text-scout-red" role="alert">{error}</p>}
      <ul className="divide-y rounded-lg border">
        {feeds.map((f) => (
          <li key={f.id} className="space-y-2 p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="font-bold">
                  {f.name} {f.revoked_at && <span className="badge ml-1 bg-gray-200 text-gray-700">Revoked</span>}
                </p>
                <p className="text-sm text-gray-600">
                  {showOwner && f.owner_name ? `${f.owner_name} · ` : ''}
                  Link ending …{f.token_hint} · created {formatLondon(f.regenerated_at ?? f.created_at, { dateStyle: 'medium' })}
                  {f.last_used_at ? ` · last checked ${formatLondon(f.last_used_at, { dateStyle: 'medium', timeStyle: 'short' })}` : ' · not used yet'}
                  {f.kind === 'admin' && f.show_names ? ' · shows who booked' : ''}
                </p>
              </div>
              {!f.revoked_at && (
                <div className="flex gap-2">
                  <button type="button" className="btn-secondary" disabled={busy === f.id} onClick={() => regenerate(f)}>Replace link</button>
                  <button type="button" className="btn-danger" disabled={busy === f.id} onClick={() => revoke(f)}>Revoke</button>
                </div>
              )}
            </div>
            {newUrl?.id === f.id && <NewFeedUrl url={newUrl.url} onDone={() => setNewUrl(null)} />}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Subscribe to bookings from a calendar app (FR17 §2.3–2.4): a person's own
 * bookings, or an organisation's for its managers.
 */
export function CalendarSubscriptions({ organisation }: { organisation?: { id: string; name: string } }) {
  const path = organisation ? `/calendar-feeds?organisation_id=${encodeURIComponent(organisation.id)}` : '/calendar-feeds';
  const [feeds, setFeeds] = useState<CalendarFeed[] | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    api.get<CalendarFeed[]>(path).then(setFeeds, (e) => setError(e instanceof ApiError ? e.message : 'Could not load calendar links'));
  }, [path, version]);

  // Arriving from a booking's "subscribe to your bookings" link.
  useEffect(() => {
    if (!organisation && feeds && window.location.hash === '#calendar') document.getElementById('calendar')?.scrollIntoView();
  }, [organisation, feeds]);

  async function create() {
    setWorking(true);
    setError(null);
    try {
      const r = await api.post<{ url: string }>('/calendar-feeds', organisation ? { kind: 'organisation', organisation_id: organisation.id } : { kind: 'user' });
      setCreated(r.url);
      setVersion((v) => v + 1);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not create the link');
    } finally {
      setWorking(false);
    }
  }

  const id = organisation ? 'org-calendar-heading' : 'calendar-heading';
  return (
    <section className="card mt-6 space-y-4" id={organisation ? undefined : 'calendar'} aria-labelledby={id}>
      <div>
        <h2 id={id} className="text-xl">{organisation ? 'Organisation calendar' : 'Calendar subscription'}</h2>
        <p className="text-sm text-gray-600">
          {organisation
            ? `Subscribe in Google Calendar, Outlook or Apple Calendar to see all of ${organisation.name}’s bookings. New bookings, changes and cancellations appear when your calendar app next checks.`
            : 'Subscribe in Google Calendar, Outlook or Apple Calendar to see your bookings there. New bookings, changes and cancellations appear when your calendar app next checks.'}
        </p>
      </div>
      {error && <p className="text-sm font-bold text-scout-red" role="alert">{error}</p>}
      {created && <NewFeedUrl url={created} onDone={() => setCreated(null)} />}
      {feeds && <FeedList feeds={feeds} onChanged={() => setVersion((v) => v + 1)} showOwner={!!organisation} />}
      <button type="button" className="btn-primary" onClick={create} disabled={working}>
        {working ? 'Creating…' : 'Create calendar link'}
      </button>
    </section>
  );
}
