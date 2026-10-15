import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useAuth } from '../lib/auth';
import { Spinner, EmptyState, ErrorState, StatusBadge } from '../components/ui';
import { OrganisationForm } from '../components/OrganisationForm';
import { formatGBP } from '@shared/pricing';
import { formatLondon } from '@shared/londonTime';

interface Member { user_id: string; full_name: string; email: string; role: 'manager' | 'member'; }
interface Invitation { id: string; email: string; role: string; status: string; expires_at: string; }
interface OrganisationDetailData {
  id: string;
  name: string;
  organisation_type_id: string;
  organisation_type: string;
  pricing_category_id: string;
  category_label: string;
  contact_email: string;
  contact_phone: string | null;
  my_role: 'manager' | 'member' | null;
  members: Member[];
  invitations?: Invitation[];
}
interface OrgBooking {
  id: string; reference: string; resource_name: string; starts_at: string; ends_at: string;
  status: string; total_amount_pence: number; booked_by: string;
}

export default function OrganisationDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const { data, loading, error, setData } = useApi<OrganisationDetailData>(`/organisations/${id}`, [id]);
  const { data: bookings } = useApi<OrgBooking[]>(`/organisations/${id}/bookings`, [id]);
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'member' | 'manager'>('member');
  const [working, setWorking] = useState(false);

  async function reload() {
    setData(await api.get<OrganisationDetailData>(`/organisations/${id}`));
  }

  async function run(action: () => Promise<unknown>, success: string) {
    setWorking(true);
    setMessage(null);
    try {
      await action();
      await reload();
      setMessage({ kind: 'ok', text: success });
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof ApiError ? e.message : 'Something went wrong' });
    } finally {
      setWorking(false);
    }
  }

  if (loading) return <Spinner />;
  if (error) return <ErrorState message={error} />;
  if (!data) return null;
  const isManager = data.my_role === 'manager';
  const pending = data.invitations?.filter((i) => i.status === 'pending') ?? [];

  return (
    <div className="mx-auto max-w-3xl">
      <Link to={data.my_role ? '/organisations' : '/admin/organisations'} className="text-sm font-bold text-scout-purple">← Organisations</Link>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-3xl">{data.name}</h1>
          <p className="text-gray-600">{data.organisation_type} · {data.category_label}</p>
        </div>
        {data.my_role && <span className="badge bg-scout-purple/10 text-scout-purple">You are a {data.my_role === 'manager' ? 'Manager' : 'Member'}</span>}
      </div>

      {message && (
        <p className={`mt-4 text-sm font-bold ${message.kind === 'ok' ? 'text-scout-green' : 'text-scout-red'}`} role={message.kind === 'ok' ? 'status' : 'alert'}>
          {message.text}
        </p>
      )}

      <section className="card mt-6">
        {editing ? (
          <OrganisationForm
            initial={{ ...data, contact_phone: data.contact_phone ?? '' }}
            submitLabel="Save details"
            onCancel={() => setEditing(false)}
            onSubmit={async (draft) => {
              await api.put(`/organisations/${id}`, draft);
              await reload();
              setEditing(false);
              setMessage({ kind: 'ok', text: 'Details saved.' });
            }}
          />
        ) : (
          <div className="flex flex-wrap items-start justify-between gap-3">
            <dl className="space-y-1 text-sm">
              <div><dt className="inline text-gray-500">Contact email: </dt><dd className="inline font-bold">{data.contact_email}</dd></div>
              <div><dt className="inline text-gray-500">Contact telephone: </dt><dd className="inline font-bold">{data.contact_phone ?? '—'}</dd></div>
            </dl>
            <div className="flex gap-2">
              {data.my_role && <Link className="btn-primary" to="/resources">Book for this organisation</Link>}
              {isManager && <button className="btn-secondary" onClick={() => setEditing(true)}>Edit details</button>}
            </div>
          </div>
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-xl">Members</h2>
        <div className="mt-3 space-y-2">
          {data.members.map((m) => (
            <div key={m.user_id} className="card flex flex-wrap items-center justify-between gap-2 py-4">
              <div>
                <p className="font-bold">{m.full_name}{m.user_id === user?.id && <span className="ml-2 text-xs text-gray-500">(you)</span>}</p>
                <p className="text-sm text-gray-600">{m.email} · {m.role === 'manager' ? 'Organisation Manager' : 'Organisation Member'}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {isManager && m.role === 'member' && (
                  <button className="btn-secondary" disabled={working} onClick={() => run(() => api.put(`/organisations/${id}/members/${m.user_id}`, { role: 'manager' }), `${m.full_name} is now a manager.`)}>
                    Make manager
                  </button>
                )}
                {isManager && m.role === 'manager' && (
                  <button className="btn-secondary" disabled={working} onClick={() => run(() => api.put(`/organisations/${id}/members/${m.user_id}`, { role: 'member' }), `${m.full_name} is no longer a manager.`)}>
                    Remove manager role
                  </button>
                )}
                {(isManager || m.user_id === user?.id) && data.my_role && (
                  <button
                    className="btn-secondary"
                    disabled={working}
                    onClick={() => {
                      const self = m.user_id === user?.id;
                      if (!confirm(self ? `Leave ${data.name}?` : `Remove ${m.full_name} from ${data.name}?`)) return;
                      void run(() => api.del(`/organisations/${id}/members/${m.user_id}`), self ? 'You have left the organisation.' : `${m.full_name} was removed.`);
                    }}
                  >
                    {m.user_id === user?.id ? 'Leave' : 'Remove'}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {isManager && (
        <section className="mt-8">
          <h2 className="text-xl">Invite someone</h2>
          <form
            className="card mt-3 grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => api.post(`/organisations/${id}/invitations`, { email: inviteEmail, role: inviteRole }), `Invitation sent to ${inviteEmail}.`).then(() => setInviteEmail(''));
            }}
          >
            <div>
              <label className="label" htmlFor="inv-email">Email address</label>
              <input id="inv-email" type="email" className="input" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} required />
            </div>
            <div>
              <label className="label" htmlFor="inv-role">Role</label>
              <select id="inv-role" className="input" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as 'member' | 'manager')}>
                <option value="member">Member</option>
                <option value="manager">Manager</option>
              </select>
            </div>
            <button className="btn-primary" disabled={working}>Send invitation</button>
          </form>
          {pending.length > 0 && (
            <div className="mt-3 space-y-2">
              {pending.map((i) => (
                <div key={i.id} className="card flex flex-wrap items-center justify-between gap-2 py-3">
                  <p className="text-sm"><span className="font-bold">{i.email}</span> · {i.role} · expires {formatLondon(i.expires_at, { dateStyle: 'medium' })}</p>
                  <button className="btn-secondary" disabled={working} onClick={() => run(() => api.del(`/organisations/${id}/invitations/${i.id}`), 'Invitation revoked.')}>Revoke</button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <section className="mt-8">
        <h2 className="text-xl">Organisation bookings</h2>
        <div className="mt-3 space-y-2">
          {!bookings && <Spinner />}
          {bookings && bookings.length === 0 && <EmptyState title="No bookings yet" />}
          {bookings?.map((b) => (
            <Link key={b.id} to={`/bookings/${b.id}`} className="card flex flex-wrap items-center justify-between gap-2 py-4 hover:shadow-md">
              <div>
                <p className="font-bold">{b.resource_name}</p>
                <p className="text-sm text-gray-600">{formatLondon(b.starts_at)} · booked by {b.booked_by}</p>
                <p className="text-xs text-gray-400">Ref {b.reference}</p>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-bold">{formatGBP(b.total_amount_pence)}</span>
                <StatusBadge status={b.status} />
              </div>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
