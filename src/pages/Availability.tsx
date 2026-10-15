import { useEffect, useMemo, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { useApi } from '../lib/useApi';
import { api, ApiError } from '../lib/api';
import { Spinner, ErrorState } from '../components/ui';

interface ResourceOpt {
  id: string;
  name: string;
  slug: string;
  requires_approval: boolean;
}

interface AvailabilityResponse {
  available: boolean;
  reason?: string;
  conflictingResourceId?: string;
}

function toISO(date: string, time: string): string {
  return new Date(`${date}T${time}:00`).toISOString();
}

export default function Availability() {
  const { data: resources, loading, error } = useApi<ResourceOpt[]>('/resources');
  const [params] = useSearchParams();
  const [resourceSlug, setResourceSlug] = useState('');
  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [start, setStart] = useState('10:00');
  const [end, setEnd] = useState('12:00');
  const [result, setResult] = useState<AvailabilityResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  useEffect(() => {
    if (resources && resources.length) {
      const fromQuery = params.get('resource');
      setResourceSlug(fromQuery && resources.some((r) => r.slug === fromQuery) ? fromQuery : resources[0].slug);
    }
  }, [resources, params]);

  const selected = useMemo(() => resources?.find((r) => r.slug === resourceSlug), [resources, resourceSlug]);

  async function check() {
    if (!selected) return;
    setChecking(true);
    setCheckError(null);
    setResult(null);
    try {
      const startsAt = toISO(date, start);
      const endsAt = toISO(date, end);
      if (new Date(endsAt) <= new Date(startsAt)) {
        setCheckError('End time must be after start time');
        return;
      }
      const res = await api.get<AvailabilityResponse>(
        `/availability?resource_id=${selected.id}&starts_at=${encodeURIComponent(startsAt)}&ends_at=${encodeURIComponent(endsAt)}`,
      );
      setResult(res);
    } catch (e) {
      setCheckError(e instanceof ApiError ? e.message : 'Could not check availability');
    } finally {
      setChecking(false);
    }
  }

  if (loading) return <Spinner />;
  if (error) return <ErrorState message={error} />;

  return (
    <div>
      <h1 className="text-3xl">Availability</h1>
      <p className="mt-2 text-gray-600">Check whether a resource is free for your chosen date and time. No account needed.</p>

      <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_1.2fr]">
        <div className="card">
          <div className="space-y-4">
            <div>
              <label className="label" htmlFor="resource">Resource</label>
              <select id="resource" className="input" value={resourceSlug} onChange={(e) => setResourceSlug(e.target.value)}>
                {resources?.map((r) => (
                  <option key={r.id} value={r.slug}>{r.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="date">Date</label>
              <input id="date" type="date" min={today} className="input" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="label" htmlFor="start">Start time</label>
                <input id="start" type="time" className="input" value={start} onChange={(e) => setStart(e.target.value)} />
              </div>
              <div>
                <label className="label" htmlFor="end">End time</label>
                <input id="end" type="time" className="input" value={end} onChange={(e) => setEnd(e.target.value)} />
              </div>
            </div>
            <button className="btn-primary w-full" onClick={check} disabled={checking}>
              {checking ? 'Checking…' : 'Check availability'}
            </button>
          </div>
        </div>

        <div>
          {checkError && <ErrorState message={checkError} />}
          {result && (
            <div className={`card ${result.available ? 'border-scout-green/40 bg-scout-green/5' : 'border-scout-red/40 bg-scout-red/5'}`}>
              {result.available ? (
                <>
                  <h2 className="text-xl text-scout-green">Available</h2>
                  <p className="mt-2 text-gray-700">
                    {selected?.name} is free on {date} from {start} to {end}.
                  </p>
                  {selected && (
                    <Link to={`/book/${selected.slug}?date=${date}&start=${start}&end=${end}`} className="btn-primary mt-4">
                      Book this slot
                    </Link>
                  )}
                </>
              ) : (
                <>
                  <h2 className="text-xl text-scout-red">Not available</h2>
                  <p className="mt-2 text-gray-700">
                    {result.reason === 'closure'
                      ? 'This period is blocked by the venue.'
                      : result.reason === 'inactive'
                        ? 'This resource is not currently available.'
                        : 'This slot conflicts with an existing booking.'}
                  </p>
                </>
              )}
            </div>
          )}
          {!result && !checkError && (
            <div className="card text-gray-500">Choose a resource, date and time, then check availability.</div>
          )}
          <p className="mt-4 text-xs text-gray-500">
            Availability is confirmed again when you submit a booking.
          </p>
        </div>
      </div>
    </div>
  );
}
