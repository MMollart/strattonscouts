import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { ErrorState, Spinner } from '../../components/ui';
import { FeedList, NewFeedUrl, type CalendarFeed } from '../../components/CalendarFeeds';

interface Option {
  id: string;
  name: string;
  parent_id?: string | null;
}

const KIND_LABEL: Record<CalendarFeed['kind'], string> = {
  admin: 'Venue calendars',
  organisation: 'Organisation calendars',
  user: 'Personal calendars',
};

/**
 * Admin → Calendar subscriptions (FR17 §2.5): venue calendars for one,
 * several or all resources, and every calendar link anyone has made, so a
 * link can be revoked if it is shared by mistake.
 */
export default function AdminCalendarFeeds() {
  const { data: resources } = useApi<Option[]>('/admin/resources');
  const [feeds, setFeeds] = useState<CalendarFeed[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [all, setAll] = useState(true);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [showNames, setShowNames] = useState(false);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    api.get<CalendarFeed[]>('/calendar-feeds?scope=all').then(setFeeds, (e) => setLoadError(e instanceof ApiError ? e.message : 'Could not load calendar links'));
  }, [version]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!all && !chosen.size) {
      setError('Choose at least one resource, or All resources');
      return;
    }
    setWorking(true);
    setError(null);
    try {
      const r = await api.post<{ url: string }>('/calendar-feeds', {
        kind: 'admin',
        name: name.trim() || undefined,
        resource_ids: all ? null : [...chosen],
        show_names: showNames,
      });
      setCreated(r.url);
      setName('');
      setVersion((v) => v + 1);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the calendar');
    } finally {
      setWorking(false);
    }
  }

  const toggle = (id: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(id);
    else next.delete(id);
    setChosen(next);
  };

  return (
    <div className="mx-auto max-w-3xl">
      <Link to="/admin" className="text-sm font-bold text-scout-purple">← Dashboard</Link>
      <h1 className="mt-2 text-3xl">Calendar subscriptions</h1>
      <p className="mt-2 text-gray-600">
        Subscribe to venue bookings in Google Calendar, Outlook or Apple Calendar. Calendars are read-only copies: changing an entry in your
        calendar app does not change the booking. Calendar apps check for changes on their own schedule, often every few hours.
      </p>

      <form className="card mt-6 space-y-4" onSubmit={create} aria-labelledby="new-venue-calendar">
        <h2 id="new-venue-calendar" className="text-xl">New venue calendar</h2>
        <div>
          <label className="label" htmlFor="cal-name">Name (optional)</label>
          <input id="cal-name" className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="For example, Caretaker’s calendar" />
        </div>
        <fieldset className="space-y-2">
          <legend className="label">Resources</legend>
          <label className="flex items-center gap-2">
            <input type="radio" name="cal-scope" checked={all} onChange={() => setAll(true)} /> All resources
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="cal-scope" checked={!all} onChange={() => setAll(false)} /> Chosen resources
          </label>
          {!all && (
            <div className="grid gap-1 rounded-lg border p-3 sm:grid-cols-2">
              {resources?.map((r) => (
                <label key={r.id} className="flex items-center gap-2">
                  <input type="checkbox" checked={chosen.has(r.id)} onChange={(e) => toggle(r.id, e.target.checked)} /> {r.name}
                </label>
              ))}
              <p className="text-sm text-gray-600 sm:col-span-2">Choosing a resource also includes everything that is part of it.</p>
            </div>
          )}
        </fieldset>
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-1" checked={showNames} onChange={(e) => setShowNames(e.target.checked)} />
          <span>
            Show who booked (the organisation, or the customer’s name for personal bookings).
            <span className="block text-sm text-gray-600">Leave this off if the calendar will be shared. Contact details and notes are never included.</span>
          </span>
        </label>
        {error && <p className="text-sm font-bold text-scout-red" role="alert">{error}</p>}
        <button className="btn-primary" disabled={working}>{working ? 'Creating…' : 'Create calendar link'}</button>
        {created && <NewFeedUrl url={created} onDone={() => setCreated(null)} />}
      </form>

      {loadError && <ErrorState message={loadError} />}
      {!feeds && !loadError && <Spinner />}
      {feeds &&
        (['admin', 'organisation', 'user'] as const).map((kind) => {
          const list = feeds.filter((f) => f.kind === kind);
          return (
            <section key={kind} className="card mt-6 space-y-3" aria-labelledby={`feeds-${kind}`}>
              <h2 id={`feeds-${kind}`} className="text-xl">{KIND_LABEL[kind]}</h2>
              <FeedList
                feeds={list.map((f) => ({
                  ...f,
                  name: f.resource_ids ? `${f.name} (${f.resource_ids.map((id) => resources?.find((r) => r.id === id)?.name ?? id).join(', ')})` : f.name,
                }))}
                onChanged={() => setVersion((v) => v + 1)}
                showOwner
              />
            </section>
          );
        })}
    </div>
  );
}
