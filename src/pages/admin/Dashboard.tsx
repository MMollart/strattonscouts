import { Link } from 'react-router-dom';
import { useApi } from '../../lib/useApi';
import { Spinner, ErrorState, StatusBadge } from '../../components/ui';
import { formatLondon } from '@shared/londonTime';
import { useAuth } from '../../lib/auth';
import { visibleMenu } from './menu';

interface Dashboard {
  upcoming_bookings: number;
  confirmed_bookings: number;
  pending_approval: number;
  provisional: number;
  recent_bookings: {
    id: string;
    reference: string;
    resource_name: string;
    status: string;
    starts_at: string;
    created_at: string;
  }[];
}

export default function AdminDashboard() {
  const { data, loading, error } = useApi<Dashboard>('/admin/dashboard');
  const { can } = useAuth();

  if (loading) return <Spinner />;
  if (error) return <ErrorState message={error} />;
  if (!data) return null;

  return (
    <div>
      <h1 className="text-3xl">Administration</h1>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Upcoming bookings" value={data.upcoming_bookings} />
        <Metric label="Confirmed" value={data.confirmed_bookings} />
        <Metric label="Awaiting approval" value={data.pending_approval} accent to={data.pending_approval > 0 ? '/admin/bookings' : undefined} />
        <Metric label="Provisional holds" value={data.provisional} />
      </div>

      <h2 className="mt-8 text-xl">What do you want to do?</h2>
      <div className="mt-3 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {visibleMenu(can).map((g, n) => (
          <section key={g.title} className="card" aria-labelledby={`dash-group-${n}`}>
            <h3 id={`dash-group-${n}`} className="text-lg">{g.title}</h3>
            <p className="text-sm text-gray-500">{g.description}</p>
            <ul className="mt-3 space-y-2">
              {g.items.map((i) => (
                <li key={i.to}>
                  <Link to={i.to} className="block rounded-lg p-2 -mx-2 hover:bg-scout-purple/10">
                    <span className="font-bold text-scout-purple">{i.label}</span>
                    <span className="block text-xs text-gray-600">{i.description}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <h2 className="mt-8 text-xl">Recent activity</h2>
      <div className="mt-3 space-y-2">
        {data.recent_bookings.length === 0 && <p className="text-gray-500">No bookings yet.</p>}
        {data.recent_bookings.map((b) => (
          <Link key={b.id} to={`/bookings/${b.id}`} className="card flex items-center justify-between py-3 hover:shadow-md">
            <div>
              <p className="font-bold">{b.resource_name}</p>
              <p className="text-xs text-gray-500">Ref {b.reference} · {formatLondon(b.starts_at, { dateStyle: 'medium' })}</p>
            </div>
            <StatusBadge status={b.status} />
          </Link>
        ))}
      </div>
    </div>
  );
}

function Metric({ label, value, accent, to }: { label: string; value: number; accent?: boolean; to?: string }) {
  const body = (
    <>
      <p className="label">{label}</p>
      <p className={`text-4xl font-black ${accent ? 'text-scout-red' : 'text-scout-purple'}`}>{value}</p>
    </>
  );
  return to ? <Link to={to} className="card block hover:shadow-md">{body}</Link> : <div className="card">{body}</div>;
}
