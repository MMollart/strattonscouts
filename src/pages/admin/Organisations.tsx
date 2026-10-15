import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../../lib/useApi';
import { Spinner, EmptyState, ErrorState } from '../../components/ui';

export interface AdminOrganisation {
  id: string;
  name: string;
  organisation_type: string;
  category_label: string;
  contact_email: string;
  member_count: number;
  booking_count: number;
}

export default function AdminOrganisations() {
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const { data, loading, error } = useApi<AdminOrganisation[]>(`/admin/organisations?q=${encodeURIComponent(search)}`, [search]);

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-3xl">Organisations</h1>
        <Link to="/admin" className="text-sm font-bold text-scout-purple">← Dashboard</Link>
      </div>
      <form className="card mt-6 flex gap-2" onSubmit={(e) => { e.preventDefault(); setSearch(q.trim()); }}>
        <label className="sr-only" htmlFor="org-q">Search organisations</label>
        <input id="org-q" className="input" placeholder="Name or contact email" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn-primary">Search</button>
      </form>
      <div className="mt-6 space-y-2">
        {loading && <Spinner />}
        {error && <ErrorState message={error} />}
        {data && data.length === 0 && <EmptyState title="No organisations found" />}
        {data?.map((o) => (
          <Link key={o.id} to={`/organisations/${o.id}`} className="card flex flex-wrap items-center justify-between gap-2 hover:shadow-md">
            <div>
              <p className="font-black">{o.name}</p>
              <p className="text-sm text-gray-600">{o.organisation_type} · {o.category_label} · {o.contact_email}</p>
            </div>
            <p className="text-sm text-gray-600">{o.member_count} members · {o.booking_count} bookings</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
