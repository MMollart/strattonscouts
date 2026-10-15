import { Link } from 'react-router-dom';
import { useApi } from '../lib/useApi';
import { Spinner, EmptyState, ErrorState, StatusBadge } from '../components/ui';
import { formatGBP } from '@shared/pricing';

interface BookingRow {
  id: string;
  reference: string;
  resource_name: string;
  starts_at: string;
  ends_at: string;
  status: string;
  total_amount_pence: number;
}

function formatRange(startsAt: string, endsAt: string): string {
  const s = new Date(startsAt);
  const e = new Date(endsAt);
  const date = s.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const t = (d: Date) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${date}, ${t(s)}–${t(e)}`;
}

export default function MyBookings() {
  const { data, loading, error } = useApi<BookingRow[]>('/bookings');

  return (
    <div>
      <h1 className="text-3xl">My bookings</h1>
      <p className="mt-2 text-gray-600">Review your upcoming and past bookings.</p>

      <div className="mt-6">
        {loading && <Spinner />}
        {error && <ErrorState message={error} />}
        {!loading && !error && data && data.length === 0 && (
          <EmptyState title="No bookings yet">
            Browse <Link to="/resources" className="font-bold text-scout-purple">our resources</Link> to make your first booking.
          </EmptyState>
        )}
        {!loading && !error && data && data.length > 0 && (
          <div className="space-y-3">
            {data.map((b) => (
              <Link
                key={b.id}
                to={`/bookings/${b.id}`}
                className="card flex flex-col gap-2 transition hover:shadow-md sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="font-black">{b.resource_name}</p>
                  <p className="text-sm text-gray-600">{formatRange(b.starts_at, b.ends_at)}</p>
                  <p className="text-xs text-gray-400">Ref {b.reference}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-bold">{formatGBP(b.total_amount_pence)}</span>
                  <StatusBadge status={b.status} />
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
