import { useApi } from '../lib/useApi';
import { AgreementText } from './AgreementText';
import { formatLondon } from '@shared/londonTime';

interface Accepted {
  id: string;
  amendment_id: string | null;
  version_id: string;
  title: string;
  version_number: number;
  body: string;
  has_pdf: boolean;
  content_hash: string;
  accepted_at: string;
  accepted_by_name: string;
  on_behalf: boolean;
  signed_name: string | null;
  signature_image: string | null;
  has_drawn_signature: boolean;
}

/** The agreements accepted for a booking, with the exact wording of each version (FR20 §5.6). */
export function AcceptedAgreements({ bookingId }: { bookingId: string }) {
  const { data } = useApi<Accepted[]>(`/bookings/${bookingId}/agreements`, [bookingId]);
  if (!data?.length) return null;
  return (
    <section className="mt-6" aria-labelledby="accepted-agreements-heading">
      <h2 id="accepted-agreements-heading" className="text-xl">Agreements</h2>
      <ul className="mt-3 space-y-2">
        {data.map((a) => (
          <li key={a.id} className="card">
            <details>
              <summary className="cursor-pointer">
                <span className="font-black">{a.title}</span> <span className="text-sm text-gray-600">version {a.version_number}</span>
                <span className="block text-sm text-gray-600">
                  Accepted {formatLondon(a.accepted_at)} by {a.accepted_by_name}{a.on_behalf ? ' on the customer’s behalf' : ''}
                  {a.signed_name ? `, signed “${a.signed_name}”` : ''}{a.amendment_id ? ' with a change request' : ''}
                </span>
              </summary>
              <div className="mt-3 max-h-80 overflow-y-auto rounded-lg border bg-white p-3">
                <AgreementText body={a.body} />
              </div>
              {a.has_pdf && (
                <a className="mt-2 inline-block text-sm font-bold text-scout-purple underline" href={`/api/agreements/versions/${a.version_id}/pdf`} target="_blank" rel="noopener noreferrer">
                  Open the document (PDF)
                </a>
              )}
              {a.signature_image && <img src={a.signature_image} alt={`Drawn signature of ${a.signed_name ?? 'the signer'}`} className="mt-2 h-16 rounded border bg-white" />}
              {!a.signature_image && a.has_drawn_signature && <p className="mt-2 text-xs text-gray-500">A drawn signature was given.</p>}
              <p className="mt-2 break-all text-xs text-gray-400">Content fingerprint (SHA-256): {a.content_hash}</p>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}
