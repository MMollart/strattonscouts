import { Link } from 'react-router-dom';
import { useApi } from '../../lib/useApi';
import { Spinner, ErrorState, StatusBadge } from '../../components/ui';

interface Dashboard {
  upcoming_bookings: number;
  confirmed_bookings: number;
  pending_approval: number;
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

  if (loading) return <Spinner />;
  if (error) return <ErrorState message={error} />;
  if (!data) return null;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl">Administration</h1>
        <nav className="flex flex-wrap gap-2 text-sm">
          <Link to="/admin/bookings" className="btn-secondary">Bookings</Link>
          <Link to="/admin/resources" className="btn-secondary">Resources</Link>
          <Link to="/admin/pricing" className="btn-secondary">Pricing &amp; conflicts</Link>
          <Link to="/admin/users" className="btn-secondary">Users</Link>
        </nav>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <Metric label="Upcoming bookings" value={data.upcoming_bookings} />
        <Metric label="Confirmed" value={data.confirmed_bookings} />
        <Metric label="Awaiting approval" value={data.pending_approval} accent />
      </div>

      <h2 className="mt-8 text-xl">Recent activity</h2>
      <div className="mt-3 space-y-2">
        {data.recent_bookings.length === 0 && <p className="text-gray-500">No bookings yet.</p>}
        {data.recent_bookings.map((b) => (
          <Link key={b.id} to={`/bookings/${b.id}`} className="card flex items-center justify-between py-3 hover:shadow-md">
            <div>
              <p className="font-bold">{b.resource_name}</p>
              <p className="text-xs text-gray-500">Ref {b.reference} · {new Date(b.starts_at).toLocaleDateString('en-GB')}</p>
            </div>
            <StatusBadge status={b.status} />
          </Link>
        ))}
      </div>
    </div>
  );
}

function Metric({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className="card">
      <p className="label">{label}</p>
      <p className={`text-4xl font-black ${accent ? 'text-scout-red' : 'text-scout-purple'}`}>{value}</p>
    </div>
  );
}
