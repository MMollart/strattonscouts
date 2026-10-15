import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useAuth } from '../lib/auth';
import { Spinner, ErrorState } from '../components/ui';
import { formatLondon } from '@shared/londonTime';

interface InvitationInfo {
  organisation_name: string;
  role: 'manager' | 'member';
  status: string;
  expires_at: string;
  email: string;
  is_recipient: boolean;
}

export default function Invitation() {
  const { token } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { data, loading, error } = useApi<InvitationInfo>(`/invitations/${token}`, [token, user?.id]);
  const [working, setWorking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [declined, setDeclined] = useState(false);

  async function respond(action: 'accept' | 'decline') {
    setWorking(true);
    setActionError(null);
    try {
      const res = await api.post<{ organisation_id: string }>(`/invitations/${token}`, { action });
      if (action === 'accept') navigate(`/organisations/${res.organisation_id}`);
      else setDeclined(true);
    } catch (e) {
      setActionError(e instanceof ApiError ? e.message : 'Could not respond to the invitation');
    } finally {
      setWorking(false);
    }
  }

  if (loading || authLoading) return <Spinner />;
  if (error) return <div className="mx-auto max-w-lg"><ErrorState message={error} /></div>;
  if (!data) return null;
  const role = data.role === 'manager' ? 'an Organisation Manager' : 'a member';

  return (
    <div className="mx-auto max-w-lg">
      <div className="card space-y-4 text-center">
        <h1 className="text-2xl">Join {data.organisation_name}</h1>
        {declined ? (
          <p>You have declined this invitation.</p>
        ) : data.status !== 'pending' ? (
          <p className="text-scout-red">This invitation is no longer valid ({data.status}). Ask the organisation to send a new one.</p>
        ) : !user ? (
          <>
            <p>You have been invited to join as {role}. The invitation was sent to {data.email}.</p>
            <p className="text-sm text-gray-600">Sign in with that email address, or create an account with it, to respond.</p>
            <div className="flex justify-center gap-2">
              <Link to="/login" state={{ from: location.pathname }} className="btn-primary">Sign in</Link>
              <Link to="/register" state={{ from: location.pathname }} className="btn-secondary">Create account</Link>
            </div>
          </>
        ) : !data.is_recipient ? (
          <p className="text-scout-red">
            This invitation was sent to {data.email}, but you are signed in as {user.email}. Sign out and sign in with the invited address to accept it.
          </p>
        ) : (
          <>
            <p>You have been invited to join as {role}. Expires {formatLondon(data.expires_at, { dateStyle: 'long' })}.</p>
            {actionError && <ErrorState message={actionError} />}
            <div className="flex justify-center gap-2">
              <button className="btn-primary" disabled={working} onClick={() => respond('accept')}>Accept</button>
              <button className="btn-secondary" disabled={working} onClick={() => respond('decline')}>Decline</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
