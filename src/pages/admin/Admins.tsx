import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { useAuth } from '../../lib/auth';
import { Spinner, ErrorState, EmptyState } from '../../components/ui';
import { ADMIN_ROLES, ADMIN_ROLE_LABELS, type AdminRole } from '@shared/permissions';

interface AdminRow { id: string; email: string; full_name: string; role: AdminRole; granted_at: string; }
interface UserRow { id: string; email: string; full_name: string; roles: string[]; }

const ROLE_HELP: Record<AdminRole, string> = {
  super_admin: 'Everything, including pricing, email templates, administrators and settings.',
  booking_admin: 'Bookings, approvals, availability, resources and assets. No pricing or administrator changes.',
  viewer: 'Read-only access to bookings and financial information.',
};

export default function AdminAdmins() {
  const { user } = useAuth();
  const { data, loading, error } = useApi<AdminRow[]>('/admin/admins');
  const { data: users } = useApi<UserRow[]>('/admin/users');
  const [rows, setRows] = useState<AdminRow[]>([]);
  const [working, setWorking] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [newUserId, setNewUserId] = useState('');
  const [newRole, setNewRole] = useState<AdminRole>('viewer');
  const [filter, setFilter] = useState('');

  useEffect(() => { if (data) setRows(data); }, [data]);

  async function setRole(id: string, role: AdminRole | null, label: string) {
    if (role === null && !confirm(`Revoke administrator access for ${label}?`)) return;
    setWorking(id);
    setMessage(null);
    try {
      await api.put(`/admin/admins/${id}`, { role });
      setRows(await api.get<AdminRow[]>('/admin/admins'));
      setMessage({ kind: 'ok', text: role ? `${label} is now a ${ADMIN_ROLE_LABELS[role]}.` : `${label} is no longer an administrator.` });
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof ApiError ? e.message : 'Could not change the role' });
    } finally {
      setWorking(null);
    }
  }

  if (loading) return <Spinner />;
  if (error) return <ErrorState message={error} />;

  const candidates = (users ?? [])
    .filter((u) => u.roles.length === 0)
    .filter((u) => `${u.full_name} ${u.email}`.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <div>
      <h1 className="text-3xl">Administrators</h1>

      <div className="card mt-6 grid gap-2 text-sm sm:grid-cols-3">
        {ADMIN_ROLES.map((r) => (
          <div key={r}>
            <p className="font-black text-scout-purple">{ADMIN_ROLE_LABELS[r]}</p>
            <p className="text-gray-600">{ROLE_HELP[r]}</p>
          </div>
        ))}
      </div>

      {message && (
        <p className={`mt-4 text-sm font-bold ${message.kind === 'ok' ? 'text-scout-green' : 'text-scout-red'}`} role={message.kind === 'ok' ? 'status' : 'alert'}>
          {message.text}
        </p>
      )}

      <div className="mt-6 space-y-2">
        {rows.length === 0 && <EmptyState title="No administrators" />}
        {rows.map((a) => (
          <div key={a.id} className="card flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-black">{a.full_name}{a.id === user?.id && <span className="ml-2 text-xs text-gray-500">(you)</span>}</p>
              <p className="text-sm text-gray-600">{a.email}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="sr-only" htmlFor={`role-${a.id}`}>Role for {a.full_name}</label>
              <select
                id={`role-${a.id}`}
                className="input w-auto"
                value={a.role}
                disabled={working === a.id}
                onChange={(e) => setRole(a.id, e.target.value as AdminRole, a.full_name)}
              >
                {ADMIN_ROLES.map((r) => <option key={r} value={r}>{ADMIN_ROLE_LABELS[r]}</option>)}
              </select>
              <button className="btn-secondary" disabled={working === a.id} onClick={() => setRole(a.id, null, a.full_name)}>
                Revoke access
              </button>
            </div>
          </div>
        ))}
      </div>

      <form
        className="card mt-8 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          const u = users?.find((x) => x.id === newUserId);
          if (u) void setRole(u.id, newRole, u.full_name).then(() => setNewUserId(''));
        }}
      >
        <h2 className="text-xl">Add an administrator</h2>
        <p className="text-sm text-gray-600">The person must already have registered an account.</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="label" htmlFor="adm-filter">Find user</label>
            <input id="adm-filter" className="input" placeholder="Name or email" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="adm-user">User</label>
            <select id="adm-user" className="input" value={newUserId} onChange={(e) => setNewUserId(e.target.value)} required>
              <option value="">Select ({candidates.length})</option>
              {candidates.slice(0, 200).map((u) => <option key={u.id} value={u.id}>{u.full_name} · {u.email}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="adm-role">Role</label>
            <select id="adm-role" className="input" value={newRole} onChange={(e) => setNewRole(e.target.value as AdminRole)}>
              {ADMIN_ROLES.map((r) => <option key={r} value={r}>{ADMIN_ROLE_LABELS[r]}</option>)}
            </select>
          </div>
        </div>
        <button className="btn-primary" disabled={!newUserId || working !== null}>Grant access</button>
      </form>
    </div>
  );
}
