import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { useAuth } from '../../lib/auth';
import { Spinner, EmptyState, ErrorState } from '../../components/ui';
import { EMPTY_ORGANISATION, OrganisationForm } from '../../components/OrganisationForm';

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
  const { can } = useAuth();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [managerEmail, setManagerEmail] = useState('');

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-3xl">Organisations</h1>
        {can('bookings.manage') && !creating && <button className="btn-primary" onClick={() => setCreating(true)}>Add organisation</button>}
      </div>
      {creating && (
        <section className="card mt-6" aria-labelledby="new-org-heading">
          <h2 id="new-org-heading" className="text-xl">New organisation</h2>
          <div className="mt-4">
            <OrganisationForm
              initial={EMPTY_ORGANISATION}
              submitLabel="Create organisation"
              onCancel={() => setCreating(false)}
              onSubmit={async (draft) => {
                try {
                  const res = await api.post<{ id: string; manager: 'added' | 'invited' }>('/admin/organisations', { ...draft, manager_email: managerEmail });
                  navigate(`/organisations/${res.id}`);
                } catch (e) {
                  throw new Error(e instanceof ApiError ? e.message : 'Could not create the organisation');
                }
              }}
            >
              <div>
                <label className="label" htmlFor="org-manager">Organisation Manager’s email</label>
                <input id="org-manager" type="email" className="input" value={managerEmail} onChange={(e) => setManagerEmail(e.target.value)} required />
                <p className="mt-1 text-xs text-gray-500">
                  If they already have an account they become its Manager straight away; otherwise they are emailed an invitation to manage it.
                </p>
              </div>
            </OrganisationForm>
          </div>
        </section>
      )}
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
