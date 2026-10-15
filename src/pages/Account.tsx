import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useAuth, type SessionUser } from '../lib/auth';
import { Spinner } from '../components/ui';

interface Category { id: string; name: string; label: string; }

export default function Account() {
  const { user, setUser } = useAuth();
  const { data: categories } = useApi<Category[]>('/categories');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (user) {
      setFullName(user.full_name);
      setPhone(user.phone ?? '');
    }
  }, [user]);

  if (!user) return <Spinner />;

  const category = categories?.find((c) => c.id === user.pricing_category_id);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await api.put<SessionUser>('/account', { full_name: fullName, phone });
      setUser(updated);
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save changes');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-3xl">My account</h1>

      <div className="card mt-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="label">Email</p>
            <p className="font-bold">{user.email}</p>
          </div>
          <div className="text-right">
            <p className="label">Customer category</p>
            <p className="font-bold text-scout-purple">{category?.label ?? '—'}</p>
          </div>
        </div>
        <p className="mt-3 text-xs text-gray-500">
          Your category determines the prices you are shown. To change category, please contact an administrator.
        </p>
      </div>

      <form className="card mt-6 space-y-4" onSubmit={submit}>
        <h2 className="text-xl">Contact details</h2>
        <div>
          <label className="label" htmlFor="full_name">Full name</label>
          <input id="full_name" className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
        </div>
        <div>
          <label className="label" htmlFor="phone">Contact telephone</label>
          <input id="phone" className="input" value={phone} onChange={(e) => setPhone(e.target.value)} required />
        </div>
        {error && <p className="text-sm font-bold text-scout-red" role="alert">{error}</p>}
        {saved && <p className="text-sm font-bold text-scout-green" role="status">Changes saved.</p>}
        <button className="btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button>
      </form>
    </div>
  );
}
