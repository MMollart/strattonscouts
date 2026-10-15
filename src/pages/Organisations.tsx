import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useApi } from '../lib/useApi';
import { Spinner, EmptyState, ErrorState } from '../components/ui';
import { EMPTY_ORGANISATION, OrganisationForm } from '../components/OrganisationForm';

export interface MyOrganisation {
  id: string;
  name: string;
  organisation_type: string;
  category_label: string;
  pricing_category_id: string;
  role: 'manager' | 'member';
  member_count: number;
}

export default function Organisations() {
  const navigate = useNavigate();
  const { data, loading, error } = useApi<MyOrganisation[]>('/organisations');
  const [creating, setCreating] = useState(false);

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-3xl">My organisations</h1>
      <p className="mt-2 text-gray-600">
        Create an organisation for your Scout Group, unit, club or community group, invite others, and book on its behalf.
      </p>

      <div className="mt-6">
        {creating ? (
          <div className="card">
            <h2 className="mb-4 text-xl">New organisation</h2>
            <OrganisationForm
              initial={EMPTY_ORGANISATION}
              submitLabel="Create organisation"
              onCancel={() => setCreating(false)}
              onSubmit={async (draft) => {
                const created = await api.post<{ id: string }>('/organisations', draft);
                navigate(`/organisations/${created.id}`);
              }}
            />
          </div>
        ) : (
          <button className="btn-primary" onClick={() => setCreating(true)}>Create an organisation</button>
        )}
      </div>

      <div className="mt-6 space-y-3">
        {loading && <Spinner />}
        {error && <ErrorState message={error} />}
        {data && data.length === 0 && <EmptyState title="You are not part of any organisation yet">If someone has invited you, use the link in their email.</EmptyState>}
        {data?.map((o) => (
          <Link key={o.id} to={`/organisations/${o.id}`} className="card flex flex-wrap items-center justify-between gap-2 hover:shadow-md">
            <div>
              <p className="font-black">{o.name}</p>
              <p className="text-sm text-gray-600">{o.organisation_type} · {o.category_label} · {o.member_count} member{o.member_count === 1 ? '' : 's'}</p>
            </div>
            <span className="badge bg-scout-purple/10 text-scout-purple">{o.role === 'manager' ? 'Manager' : 'Member'}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
