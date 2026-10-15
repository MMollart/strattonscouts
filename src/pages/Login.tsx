import { useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth, type SessionUser } from '../lib/auth';

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { setUser } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const from = (location.state as { from?: string } | null)?.from ?? '/my-bookings';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const user = await api.post<SessionUser>('/auth/login', { email, password });
      setUser(user);
      navigate(from);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-3xl">Log in</h1>
      <form className="card mt-6 space-y-4" onSubmit={submit}>
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input id="email" type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <input id="password" type="password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        {error && <p className="text-sm font-bold text-scout-red" role="alert">{error}</p>}
        <button className="btn-primary w-full" disabled={submitting}>{submitting ? 'Logging in…' : 'Log in'}</button>
        <div className="flex justify-between text-sm">
          <Link to="/forgot-password" className="font-bold text-scout-purple">Forgot password?</Link>
          <Link to="/register" className="font-bold text-scout-purple">Create account</Link>
        </div>
      </form>
    </div>
  );
}
