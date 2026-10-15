import { useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useAuth, type SessionUser } from '../lib/auth';

interface Category { id: string; name: string; label: string; }

export default function Register() {
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/my-bookings';
  const { setUser } = useAuth();
  const { data: categories } = useApi<Category[]>('/categories');
  const [form, setForm] = useState({ full_name: '', email: '', phone: '', password: '', category: 'scouts' });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const user = await api.post<SessionUser>('/auth/register', form);
      setUser(user);
      navigate(from);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Registration failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-3xl">Create an account</h1>
      <p className="mt-2 text-gray-600">Choose your category to see the right prices straight away.</p>
      <form className="card mt-6 space-y-4" onSubmit={submit}>
        <Field label="Full name" id="full_name" value={form.full_name} onChange={(v) => setForm({ ...form, full_name: v })} />
        <Field label="Email" id="email" type="email" value={form.email} onChange={(v) => setForm({ ...form, email: v })} />
        <Field label="Contact telephone" id="phone" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} />
        <Field label="Password (min 10 characters)" id="password" type="password" value={form.password} onChange={(v) => setForm({ ...form, password: v })} />
        <div>
          <label className="label" htmlFor="category">Customer category</label>
          <select id="category" className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
            {categories?.map((c) => <option key={c.id} value={c.name}>{c.label}</option>)}
          </select>
        </div>
        {error && <p className="text-sm font-bold text-scout-red" role="alert">{error}</p>}
        <button className="btn-primary w-full" disabled={submitting}>{submitting ? 'Creating…' : 'Create account'}</button>
        <p className="text-center text-sm">Already registered? <Link to="/login" className="font-bold text-scout-purple">Log in</Link></p>
      </form>
    </div>
  );
}

function Field({ label, id, value, onChange, type = 'text' }: { label: string; id: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <div>
      <label className="label" htmlFor={id}>{label}</label>
      <input id={id} type={type} className="input" value={value} onChange={(e) => onChange(e.target.value)} required />
    </div>
  );
}
