import { useState } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';

export default function ResetPassword() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.post('/auth/password-reset-confirm', { token, password });
      navigate('/login', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Reset failed');
    } finally {
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <div className="mx-auto max-w-md">
        <h1 className="text-3xl">Reset password</h1>
        <div className="card mt-6">
          <p>This reset link is missing or invalid. Please request a new one.</p>
          <Link to="/forgot-password" className="mt-4 inline-block font-bold text-scout-purple">Request a new link</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-3xl">Choose a new password</h1>
      <form className="card mt-6 space-y-4" onSubmit={submit}>
        <div>
          <label className="label" htmlFor="password">New password (min 10 characters)</label>
          <input id="password" type="password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} />
        </div>
        <div>
          <label className="label" htmlFor="confirm">Confirm password</label>
          <input id="confirm" type="password" className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} required minLength={10} />
        </div>
        {error && <p className="text-sm font-bold text-scout-red" role="alert">{error}</p>}
        <button className="btn-primary w-full" disabled={submitting}>{submitting ? 'Saving…' : 'Set new password'}</button>
      </form>
    </div>
  );
}
