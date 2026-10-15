import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { useAuth } from '../../lib/auth';
import { EmptyState, ErrorState, Spinner } from '../../components/ui';
import { formatLondon } from '@shared/londonTime';

interface Template {
  key: string;
  name: string;
  trigger: string;
  required: boolean;
  customised: boolean;
  subject: string;
  body_text: string;
  body_html: string | null;
  is_enabled: boolean;
  updated_at: string | null;
  parameters: { name: string; description: string }[];
}

interface EmailRow {
  id: string;
  recipient: string;
  template: string;
  subject: string | null;
  status: string;
  error: string | null;
  provider_ref: string | null;
  attempts: number;
  next_attempt_at: string | null;
  created_at: string;
  sent_at: string | null;
  booking_id: string | null;
  booking_reference: string | null;
}

/** Admin: email templates and email history (FR06). */
export default function AdminEmails() {
  const { can } = useAuth();
  const [tab, setTab] = useState<'templates' | 'history'>(can('email_templates.manage') ? 'templates' : 'history');
  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-3xl">Emails</h1>
        <Link to="/admin" className="text-sm font-bold text-scout-purple">← Dashboard</Link>
      </div>
      <div role="tablist" className="mt-4 flex gap-2">
        {can('email_templates.manage') && (
          <button role="tab" aria-selected={tab === 'templates'} className={tab === 'templates' ? 'btn-primary' : 'btn-secondary'} onClick={() => setTab('templates')}>Templates</button>
        )}
        <button role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'btn-primary' : 'btn-secondary'} onClick={() => setTab('history')}>History</button>
      </div>
      {tab === 'templates' ? <Templates /> : <History />}
    </div>
  );
}

function Templates() {
  const { data, loading, error, setData } = useApi<Template[]>('/admin/email-templates');
  const [editing, setEditing] = useState<string | null>(null);
  if (loading) return <Spinner />;
  if (error) return <ErrorState message={error} />;
  const reload = async () => setData(await api.get<Template[]>('/admin/email-templates'));
  return (
    <div className="mt-6 space-y-2">
      {data?.map((t) =>
        editing === t.key ? (
          <TemplateEditor key={t.key} template={t} onClose={() => setEditing(null)} onSaved={reload} />
        ) : (
          <div key={t.key} className="card flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="font-black">
                {t.name}{' '}
                {!t.is_enabled && <span className="badge bg-gray-200 text-gray-600">off</span>}
                {t.customised && <span className="badge bg-scout-purple/10 text-scout-purple">edited</span>}
              </p>
              <p className="text-sm text-gray-600">{t.trigger}</p>
              <p className="text-xs text-gray-500">Subject: {t.subject}</p>
            </div>
            <button className="btn-secondary" onClick={() => setEditing(t.key)}>Edit</button>
          </div>
        ),
      )}
    </div>
  );
}

function TemplateEditor({ template, onClose, onSaved }: { template: Template; onClose: () => void; onSaved: () => Promise<void> }) {
  const [subject, setSubject] = useState(template.subject);
  const [bodyText, setBodyText] = useState(template.body_text);
  const [bodyHtml, setBodyHtml] = useState(template.body_html ?? '');
  const [enabled, setEnabled] = useState(template.is_enabled);
  const [preview, setPreview] = useState<{ subject: string; text: string; html: string; unknown: string[] } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const focused = useRef<{ el: HTMLInputElement | HTMLTextAreaElement; set: (v: string) => void } | null>(null);
  const content = { subject, body_text: bodyText, body_html: bodyHtml.trim() || null };

  // Live preview, debounced.
  useEffect(() => {
    const timer = setTimeout(() => {
      api.post<typeof preview>(`/admin/email-templates/${template.key}/preview`, content).then(setPreview).catch(() => setPreview(null));
    }, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subject, bodyText, bodyHtml]);

  function insert(param: string) {
    const target = focused.current;
    const token = `{{ ${param} }}`;
    if (!target) return setBodyText(`${bodyText}${token}`);
    const { el, set } = target;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    set(el.value.slice(0, start) + token + el.value.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  }

  async function act(action: () => Promise<unknown>, done: string, close = false) {
    setWorking(true);
    setError(null);
    setMessage(null);
    try {
      await action();
      setMessage(done);
      await onSaved();
      if (close) onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Action failed');
    } finally {
      setWorking(false);
    }
  }

  const track = (set: (v: string) => void) => (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    focused.current = { el: e.currentTarget, set };
  };

  return (
    <div className="card space-y-4" aria-labelledby={`tpl-${template.key}`}>
      <div>
        <h2 id={`tpl-${template.key}`} className="text-xl">{template.name}</h2>
        <p className="text-sm text-gray-600">{template.trigger}</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <div>
            <label className="label" htmlFor="tpl-subject">Subject</label>
            <input id="tpl-subject" className="input" maxLength={200} value={subject} onChange={(e) => setSubject(e.target.value)} onFocus={track(setSubject)} />
          </div>
          <div>
            <label className="label" htmlFor="tpl-text">Plain-text body</label>
            <textarea id="tpl-text" className="input font-mono text-sm" rows={10} value={bodyText} onChange={(e) => setBodyText(e.target.value)} onFocus={track(setBodyText)} />
          </div>
          <div>
            <label className="label" htmlFor="tpl-html">HTML body (optional; blank uses the plain text)</label>
            <textarea id="tpl-html" className="input font-mono text-sm" rows={5} value={bodyHtml} onChange={(e) => setBodyHtml(e.target.value)} onFocus={track(setBodyHtml)} />
          </div>
          <div>
            <p className="label">Insert a parameter</p>
            <div className="flex flex-wrap gap-1">
              {template.parameters.map((p) => (
                <button key={p.name} type="button" title={p.description} className="rounded-lg bg-scout-off-white px-2 py-1 font-mono text-xs hover:bg-scout-purple/10" onClick={() => insert(p.name)}>
                  {`{{ ${p.name} }}`}
                </button>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={enabled} disabled={template.required} onChange={(e) => setEnabled(e.target.checked)} />
            <span className="font-bold">Send this email automatically</span>
          </label>
          {template.required && <p className="text-xs text-gray-500">This email is needed for invitations or sign-in, so it is always sent.</p>}
        </div>
        <div>
          <p className="label">Preview with example values</p>
          {preview ? (
            <div className="rounded-xl border bg-white">
              <p className="border-b px-3 py-2 text-sm"><span className="text-gray-500">Subject:</span> <span className="font-bold">{preview.subject}</span></p>
              <iframe title="HTML preview" sandbox="" srcDoc={preview.html} className="h-72 w-full" />
              {preview.unknown.length > 0 && (
                <p className="border-t px-3 py-2 text-sm text-scout-red">Unknown parameters: {preview.unknown.map((u) => `{{ ${u} }}`).join(', ')}</p>
              )}
            </div>
          ) : (
            <p className="text-sm text-gray-500">Preparing preview…</p>
          )}
        </div>
      </div>
      {message && <p className="text-sm font-bold text-scout-green" role="status">{message}</p>}
      {error && <ErrorState message={error} />}
      <div className="flex flex-wrap gap-2">
        <button className="btn-primary" disabled={working} onClick={() => act(() => api.put(`/admin/email-templates/${template.key}`, { ...content, is_enabled: enabled }), 'Template saved.')}>Save</button>
        <button
          className="btn-secondary"
          disabled={working}
          onClick={() => act(async () => {
            const r = await api.post<{ to: string; status: string }>(`/admin/email-templates/${template.key}/test`, content);
            if (r.status !== 'sent') throw new ApiError(`The test email could not be sent (${r.status})`, 500);
          }, 'Test email sent to your address.')}
        >
          Send test to me
        </button>
        {template.customised && (
          <button className="btn-secondary" disabled={working} onClick={() => confirm('Restore the default wording for this email?') && act(() => api.del(`/admin/email-templates/${template.key}`), 'Default restored.', true)}>
            Restore default
          </button>
        )}
        <button className="btn-secondary" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

const STATUS_STYLE: Record<string, string> = {
  sent: 'bg-scout-green/15 text-scout-green',
  failed: 'bg-scout-red/15 text-scout-red',
  sending: 'bg-scout-yellow/30 text-yellow-800',
  disabled: 'bg-gray-200 text-gray-600',
};

function History() {
  const [rows, setRows] = useState<EmailRow[] | null>(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    if (status) params.set('status', status);
    try {
      setRows(await api.get<EmailRow[]>(`/admin/emails?${params}`));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load emails');
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  return (
    <div className="mt-6">
      <div className="card grid gap-3 sm:grid-cols-2">
        <form onSubmit={(e) => { e.preventDefault(); void load(); }}>
          <label className="label" htmlFor="eh-q">Search</label>
          <input id="eh-q" className="input" placeholder="Recipient or booking reference" value={q} onChange={(e) => setQ(e.target.value)} />
        </form>
        <div>
          <label className="label" htmlFor="eh-status">Status</label>
          <select id="eh-status" className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            <option value="sent">Sent</option>
            <option value="failed">Failed</option>
            <option value="disabled">Not sent (template off)</option>
          </select>
        </div>
      </div>
      {error && <ErrorState message={error} />}
      {rows === null && !error && <Spinner />}
      {rows && rows.length === 0 && <EmptyState title="No emails" />}
      {rows && rows.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="text-gray-500">
              <tr><th className="py-2">When</th><th>To</th><th>Email</th><th>Booking</th><th>Status</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t align-top">
                  <td className="py-2">{formatLondon(r.sent_at ?? r.created_at)}</td>
                  <td>{r.recipient}</td>
                  <td>
                    <p className="font-bold">{r.subject ?? r.template}</p>
                    <p className="text-xs text-gray-500">{r.template}{r.provider_ref ? ` · ref ${r.provider_ref}` : ''}</p>
                  </td>
                  <td>{r.booking_id ? <Link className="text-scout-purple underline" to={`/bookings/${r.booking_id}`}>{r.booking_reference}</Link> : r.booking_reference ?? '—'}</td>
                  <td>
                    <span className={`badge ${STATUS_STYLE[r.status] ?? 'bg-gray-100'}`}>{r.status === 'disabled' ? 'not sent' : r.status}</span>
                    {r.attempts > 1 && <p className="text-xs text-gray-500">{r.attempts} attempts</p>}
                    {r.status === 'failed' && <p className="text-xs text-scout-red">{r.error}{r.next_attempt_at ? ` · retry ${formatLondon(r.next_attempt_at, { timeStyle: 'short' })}` : ''}</p>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
