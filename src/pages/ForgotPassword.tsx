import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.post('/auth/password-reset-request', { email });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Request failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-md">
      <h1 className="text-3xl">Forgot password</h1>
      {done ? (
        <div className="card mt-6">
          <p>If an account exists for <strong>{email}</strong>, we have sent a link to reset your password. Please check your inbox.</p>
          <Link to="/login" className="mt-4 inline-block font-bold text-scout-purple">Back to log in</Link>
        </div>
      ) : (
        <form className="card mt-6 space-y-4" onSubmit={submit}>
          <p className="text-gray-600">Enter your email and we will send you a reset link.</p>
          <div>
            <label className="label" htmlFor="email">Email</label>
            <input id="email" type="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          {error && <p className="text-sm font-bold text-scout-red" role="alert">{error}</p>}
          <button className="btn-primary w-full" disabled={submitting}>{submitting ? 'Sending…' : 'Send reset link'}</button>
          <p className="text-center text-sm"><Link to="/login" className="font-bold text-scout-purple">Back to log in</Link></p>
        </form>
      )}
    </div>
  );
}
