import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { useAuth } from '../../lib/auth';
import { Spinner, ErrorState, EmptyState } from '../../components/ui';

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  pricing_category_id: string;
  category_label: string;
  roles: string[];
}

interface Category { id: string; name: string; label: string; }

export default function AdminUsers() {
  const { isSuperAdmin } = useAuth();
  const { data, loading, error } = useApi<UserRow[]>('/admin/users');
  const { data: categories } = useApi<Category[]>('/categories');
  const [rows, setRows] = useState<UserRow[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  useEffect(() => { if (data) setRows(data); }, [data]);

  async function reload() {
    setRows(await api.get<UserRow[]>('/admin/users'));
  }

  async function run(id: string, body: Record<string, unknown>) {
    setWorking(id);
    setActionError(null);
    try {
      await api.put(`/admin/users/${id}`, body);
      await reload();
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Action failed');
    } finally {
      setWorking(null);
    }
  }

  if (loading) return <Spinner />;
  if (error) return <ErrorState message={error} />;

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-3xl">Users</h1>
        <Link to="/admin" className="text-sm font-bold text-scout-purple">← Dashboard</Link>
      </div>

      {actionError && <div className="mt-4"><ErrorState message={actionError} /></div>}

      <div className="mt-6 space-y-2">
        {rows.length === 0 && <EmptyState title="No registered users yet" />}
        {rows.map((u) => {
          const isAdminUser = u.roles.includes('admin') || u.roles.includes('super_admin');
          return (
            <div key={u.id} className="card flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-black">{u.full_name}</p>
                <p className="text-sm text-gray-600">{u.email}</p>
                {u.roles.length > 0 && (
                  <p className="mt-1 flex gap-1">
                    {u.roles.map((r) => <span key={r} className="badge bg-scout-purple/10 text-scout-purple">{r.replace(/_/g, ' ')}</span>)}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <label className="sr-only" htmlFor={`cat-${u.id}`}>Category</label>
                <select
                  id={`cat-${u.id}`}
                  className="input w-auto"
                  value={u.pricing_category_id}
                  disabled={working === u.id}
                  onChange={(e) => run(u.id, { pricing_category_id: e.target.value })}
                >
                  {categories?.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
                {isSuperAdmin && (
                  u.roles.includes('super_admin') ? (
                    <button className="btn-secondary" disabled={working === u.id} onClick={() => run(u.id, { revoke_role: 'super_admin' })}>
                      Remove Super Admin
                    </button>
                  ) : isAdminUser ? (
                    <>
                      <button className="btn-secondary" disabled={working === u.id} onClick={() => run(u.id, { revoke_role: 'admin' })}>
                        Revoke admin
                      </button>
                      <button className="btn-secondary" disabled={working === u.id} onClick={() => run(u.id, { grant_role: 'super_admin' })}>
                        Make Super Admin
                      </button>
                    </>
                  ) : (
                    <button className="btn-secondary" disabled={working === u.id} onClick={() => run(u.id, { grant_role: 'admin' })}>
                      Make admin
                    </button>
                  )
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
