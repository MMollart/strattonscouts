import { useState } from 'react';
import { useApi } from '../lib/useApi';
import { api, ApiError } from '../lib/api';
import { formatGBP } from '@shared/pricing';
import { formatLondon } from '@shared/londonTime';

interface Invoice {
  id: string;
  invoice_number: string;
  amount_pence: number;
  issued_at: string;
  due_date: string;
  last_sent_at: string;
  send_count: number;
}

interface Props {
  booking: { id: string; status: string; total_amount_pence: number; organisation_name: string | null; customer_name: string };
}

/** Admin: send the hirer an invoice for the booking, and see the ones already sent. */
export function InvoicePanel({ booking }: Props) {
  const { data, setData } = useApi<Invoice[]>(`/admin/bookings/${booking.id}/invoices`, [booking.id]);
  const [recipient, setRecipient] = useState<'customer' | 'organisation'>(booking.organisation_name ? 'organisation' : 'customer');
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const canSend = booking.status === 'confirmed' && booking.total_amount_pence > 0;
  if (!canSend && !data?.length) return null;

  async function send() {
    setWorking(true);
    setNotice(null);
    setFailure(null);
    try {
      const res = await api.post<{ ok: boolean; to: string; reissued: boolean; invoice: Invoice }>(`/admin/bookings/${booking.id}/invoices`, { recipient });
      const rest = (data ?? []).filter((i) => i.id !== res.invoice.id);
      setData([res.invoice, ...rest]);
      const what = res.invoice.send_count > 1 ? `Invoice ${res.invoice.invoice_number} sent again` : `Invoice ${res.invoice.invoice_number} sent`;
      if (res.ok) setNotice(`${what} to ${res.to}.${res.reissued ? ' The price had changed, so this is a new invoice.' : ''}`);
      else setFailure(`Invoice ${res.invoice.invoice_number} was issued, but the email could not be sent yet. It will be retried automatically.`);
    } catch (e) {
      setFailure(e instanceof ApiError ? e.message : 'Could not send the invoice');
    } finally {
      setWorking(false);
    }
  }

  return (
    <section className="card mt-6" aria-labelledby="invoices-heading">
      <h2 id="invoices-heading" className="text-lg">Invoices</h2>
      {data && data.length > 0 ? (
        <ul className="mt-2 space-y-1 text-sm">
          {data.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 pb-1 last:border-0">
              <span className="font-bold">{i.invoice_number} · {formatGBP(i.amount_pence)}</span>
              <span className="text-gray-600">
                Issued {formatLondon(i.issued_at, { dateStyle: 'medium' })}, due {formatLondon(`${i.due_date}T12:00:00Z`, { dateStyle: 'medium' })}
                {i.send_count > 1 ? `, sent ${i.send_count} times (last ${formatLondon(i.last_sent_at)})` : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-sm text-gray-600">No invoice has been sent for this booking yet.</p>
      )}
      {canSend && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {booking.organisation_name && (
            <label className="text-sm">
              <span className="mr-2 text-gray-600">Send to</span>
              <select className="input w-auto" value={recipient} onChange={(e) => setRecipient(e.target.value as 'customer' | 'organisation')}>
                <option value="organisation">{booking.organisation_name} (organisation contact)</option>
                <option value="customer">{booking.customer_name} (who booked)</option>
              </select>
            </label>
          )}
          <button className="btn-secondary" onClick={send} disabled={working}>
            {working ? 'Sending…' : data?.length ? 'Send invoice again' : 'Send invoice'}
          </button>
        </div>
      )}
      {notice && <p className="mt-2 text-sm font-bold text-scout-green" role="status">{notice}</p>}
      {failure && <p className="mt-2 text-sm font-bold text-red-700" role="alert">{failure}</p>}
    </section>
  );
}
