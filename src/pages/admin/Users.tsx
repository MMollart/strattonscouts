import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { useAuth } from '../../lib/auth';
import { Spinner, ErrorState, EmptyState } from '../../components/ui';
import { Dialog } from '../../components/Dialog';

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
  const { can, user } = useAuth();
  const { data, loading, error } = useApi<UserRow[]>('/admin/users');
  const [resetting, setResetting] = useState<UserRow | null>(null);
  const { data: categories } = useApi<Category[]>('/categories');
  const [rows, setRows] = useState<UserRow[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [params] = useSearchParams();
  const [filter, setFilter] = useState(() => params.get('q') ?? '');
  const shown = rows.filter((u) => `${u.full_name} ${u.email}`.toLowerCase().includes(filter.trim().toLowerCase()));

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
        {can('admins.manage') && <Link to="/admin/admins" className="text-sm font-bold text-scout-purple">Administrators</Link>}
      </div>

      {actionError && <div className="mt-4"><ErrorState message={actionError} /></div>}

      <div className="mt-4 max-w-md">
        <label className="label" htmlFor="users-filter">Find a user</label>
        <input id="users-filter" className="input" placeholder="Name or email" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>

      <div className="mt-6 space-y-2">
        {rows.length === 0 && <EmptyState title="No registered users yet" />}
        {rows.length > 0 && shown.length === 0 && <EmptyState title="No users match" />}
        {shown.map((u) => {
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
                  disabled={working === u.id || !can('bookings.manage')}
                  onChange={(e) => run(u.id, { pricing_category_id: e.target.value })}
                >
                  {categories?.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
                {can('admins.manage') && u.id !== user?.id && (
                  <button type="button" className="btn-secondary" onClick={() => setResetting(u)}>Reset password</button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {resetting && <ResetPasswordDialog user={resetting} onClose={() => setResetting(null)} />}
    </div>
  );
}

// No look-alike characters (0/O, 1/l/I), so a password read out or copied by hand still works.
const PASSWORD_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

function generatePassword(length = 14): string {
  const bytes = crypto.getRandomValues(new Uint32Array(length));
  return Array.from(bytes, (b) => PASSWORD_CHARS[b % PASSWORD_CHARS.length]).join('');
}

/** Super Admin: choose or generate a new password for someone, then show it to pass on. */
function ResetPasswordDialog({ user, onClose }: { user: UserRow; onClose: () => void }) {
  const [password, setPassword] = useState(() => generatePassword());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [copied, setCopied] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.post(`/admin/users/${user.id}/password`, { password });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reset the password');
    } finally {
      setSaving(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Dialog title={`Reset password: ${user.full_name}`} id="reset-password-heading" onClose={onClose}>
      {done ? (
        <div className="space-y-4">
          <p role="status" className="font-bold text-scout-green">Password changed. {user.full_name} has been signed out everywhere.</p>
          <div>
            <p className="label">New password for {user.email}</p>
            <div className="flex gap-2">
              <code className="input select-all font-mono">{password}</code>
              <button type="button" className="btn-secondary" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
            </div>
          </div>
          <p className="text-sm text-gray-600">
            Pass this on privately, for example by phone. It is not shown again. They can choose their own with
            &quot;Forgot password&quot; on the login page.
          </p>
          <button type="button" className="btn-primary" onClick={onClose}>Done</button>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={save}>
          <p className="text-sm text-gray-600">
            Sets a new password for {user.email} straight away and signs them out on every device. Any reset links already emailed to them stop working.
          </p>
          <div>
            <label className="label" htmlFor="reset-password">New password (at least 10 characters)</label>
            <div className="flex gap-2">
              <input
                id="reset-password"
                className="input font-mono"
                type="text"
                autoComplete="off"
                minLength={10}
                maxLength={200}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button type="button" className="btn-secondary" onClick={() => setPassword(generatePassword())}>Generate</button>
            </div>
          </div>
          {error && <ErrorState message={error} />}
          <div className="flex gap-2">
            <button className="btn-primary" disabled={saving || password.length < 10}>{saving ? 'Saving…' : 'Set password'}</button>
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
