import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { useAuth } from '../../lib/auth';
import { EmptyState, ErrorState, Spinner } from '../../components/ui';
import { Dialog } from '../../components/Dialog';
import { AgreementText } from '../../components/AgreementText';
import { HistoryPanel } from '../../components/HistoryPanel';
import { formatLondon, fromLondon, londonToday } from '@shared/londonTime';

interface Resource { id: string; name: string }

interface TemplateRow {
  id: string;
  title: string;
  summary: string;
  applies_to_all: boolean;
  is_active: boolean;
  version_count: number;
  current_version: number | null;
  next_effective_from: string | null;
  acceptance_count: number;
  resource_ids: string[];
}

interface Version {
  id: string;
  version_number: number;
  title: string;
  body: string;
  effective_from: string;
  change_note: string;
  pdf_name: string | null;
  has_pdf: boolean;
  content_hash: string;
  created_at: string;
  created_by_name: string | null;
  acceptance_count: number;
}

interface TemplateDetail extends TemplateRow {
  versions: Version[];
}

interface AcceptanceRow {
  id: string;
  booking_id: string;
  booking_reference: string;
  resource_name: string;
  version_number: number;
  accepted_at: string;
  accepted_by_name: string;
  on_behalf: boolean;
  amendment_id: string | null;
}

const message = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

const FORMAT_HELP = '# Heading, ## Subheading, - bullet, 1. numbered, **bold**, *italic*, [link text](https://example.org). Leave a blank line between paragraphs.';

/** Admin: booking agreements, their versions and where they apply (FR20). */
export default function AdminAgreements() {
  const { can } = useAuth();
  const { data: resources } = useApi<Resource[]>('/admin/resources');
  const [rows, setRows] = useState<TemplateRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<TemplateRow | 'new' | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  async function load() {
    try {
      setRows(await api.get<TemplateRow[]>('/admin/agreements'));
    } catch (e) {
      setError(message(e, 'Could not load agreements'));
    }
  }
  useEffect(() => {
    void load();
  }, []);

  const nameOf = (id: string) => resources?.find((r) => r.id === id)?.name ?? id;
  const manage = can('agreements.manage');

  return (
    <div>
      <h1 className="text-3xl">Agreements</h1>
      <p className="mt-1 text-sm text-gray-600">
        Terms customers must read and accept when they book. An agreement applies to every booking, or to the resources you choose and everything that is part of them.
        Published versions never change: to change the wording, publish a new version with the date it takes effect.
      </p>
      {manage && <button className="btn-primary mt-4" onClick={() => setEditing('new')}>New agreement</button>}

      <div className="mt-4 space-y-2">
        {error && <ErrorState message={error} />}
        {rows === null && !error && <Spinner />}
        {rows?.length === 0 && <EmptyState title="No agreements yet">Bookings do not ask customers to accept anything until you publish one.</EmptyState>}
        {rows?.map((t) => (
          <button key={t.id} type="button" className="card block w-full text-left hover:ring-2 hover:ring-scout-purple/40" onClick={() => setOpenId(t.id)}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-black">{t.title}</p>
              <div className="flex flex-wrap gap-1">
                {!t.is_active && <span className="badge bg-gray-200 text-gray-600">Retired</span>}
                {t.current_version === null
                  ? <span className="badge bg-scout-yellow/30 text-yellow-800">No version in effect</span>
                  : <span className="badge bg-scout-green/15 text-scout-green">Version {t.current_version} in effect</span>}
                {t.next_effective_from && <span className="badge bg-scout-blue/15 text-scout-blue">New version from {formatLondon(t.next_effective_from, { dateStyle: 'medium' })}</span>}
              </div>
            </div>
            <p className="text-sm text-gray-600">
              {t.applies_to_all ? 'Every booking' : t.resource_ids.length ? t.resource_ids.map(nameOf).join(', ') : 'Not assigned to any resource'} · Accepted {t.acceptance_count} time{t.acceptance_count === 1 ? '' : 's'}
            </p>
          </button>
        ))}
      </div>

      {editing && (
        <TemplateEditor
          template={editing === 'new' ? null : editing}
          resources={resources ?? []}
          onClose={() => setEditing(null)}
          onSaved={(id) => {
            setEditing(null);
            setOpenId(id);
            void load();
          }}
        />
      )}
      {openId && !editing && (
        <TemplateView id={openId} nameOf={nameOf} onClose={() => setOpenId(null)} onEdit={(t) => setEditing(t)} onChanged={() => void load()} />
      )}
    </div>
  );
}

function TemplateEditor({ template, resources, onClose, onSaved }: { template: TemplateRow | null; resources: Resource[]; onClose: () => void; onSaved: (id: string) => void }) {
  const [form, setForm] = useState(() => ({
    title: template?.title ?? '',
    summary: template?.summary ?? '',
    applies_to_all: template?.applies_to_all ?? false,
    is_active: template?.is_active ?? true,
    resource_ids: template?.resource_ids ?? [],
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = template ? await api.put<{ id: string }>(`/admin/agreements/${template.id}`, form) : await api.post<{ id: string }>('/admin/agreements', form);
      onSaved(res.id);
    } catch (err) {
      setError(message(err, 'Could not save the agreement'));
    } finally {
      setSaving(false);
    }
  }

  const toggle = (id: string, on: boolean) =>
    setForm((f) => ({ ...f, resource_ids: on ? [...f.resource_ids, id] : f.resource_ids.filter((r) => r !== id) }));

  return (
    <Dialog id="agt-editor-heading" title={template ? `Edit ${template.title}` : 'New agreement'} onClose={onClose}>
      <form className="space-y-4" onSubmit={save}>
        <div>
          <label className="label" htmlFor="agt-title">Title</label>
          <input id="agt-title" className="input" required minLength={2} maxLength={160} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <p className="mt-1 text-xs text-gray-500">The title is saved with each version as it is published.</p>
        </div>
        <div>
          <label className="label" htmlFor="agt-summary">One-line summary shown when booking (optional)</label>
          <input id="agt-summary" className="input" maxLength={300} value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} />
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={form.applies_to_all} onChange={(e) => setForm({ ...form, applies_to_all: e.target.checked })} />
          <span><strong>Applies to every booking</strong>, whatever is booked.</span>
        </label>
        {!form.applies_to_all && (
          <fieldset>
            <legend className="label">Applies to these resources (and everything that is part of them)</legend>
            <div className="grid gap-1 sm:grid-cols-2">
              {resources.map((r) => (
                <label key={r.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={form.resource_ids.includes(r.id)} onChange={(e) => toggle(r.id, e.target.checked)} />
                  {r.name}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {template && (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
            <span><strong>In use.</strong> Untick to stop asking customers to accept it. Past acceptances are kept.</span>
          </label>
        )}
        {error && <ErrorState message={error} />}
        <div className="flex gap-2">
          <button className="btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </Dialog>
  );
}

function TemplateView({ id, nameOf, onClose, onEdit, onChanged }: { id: string; nameOf: (id: string) => string; onClose: () => void; onEdit: (t: TemplateRow) => void; onChanged: () => void }) {
  const { can } = useAuth();
  const [t, setT] = useState<TemplateDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [acceptances, setAcceptances] = useState<AcceptanceRow[] | null>(null);

  async function load() {
    try {
      setT(await api.get<TemplateDetail>(`/admin/agreements/${id}`));
    } catch (e) {
      setError(message(e, 'Could not load the agreement'));
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const manage = can('agreements.manage');
  const nowIso = new Date().toISOString();
  // The version in effect: the latest effective date that has passed.
  const current = t?.versions
    .filter((v) => v.effective_from <= nowIso)
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from) || b.version_number - a.version_number)[0];

  return (
    <Dialog id="agt-view-heading" title={t?.title ?? 'Agreement'} onClose={onClose} wide>
      {error && <ErrorState message={error} />}
      {!t && !error && <Spinner />}
      {t && (
        <>
          <p className="text-sm text-gray-600">{t.applies_to_all ? 'Applies to every booking.' : t.resource_ids.length ? `Applies to ${t.resource_ids.map(nameOf).join(', ')}.` : 'Not assigned to any resource yet.'}</p>
          {manage && (
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-secondary" onClick={() => onEdit(t)}>Edit details and resources</button>
              {!publishing && <button type="button" className="btn-primary" onClick={() => setPublishing(true)}>Publish a new version</button>}
            </div>
          )}
          {publishing && (
            <PublishVersion
              templateId={t.id}
              initialBody={t.versions[0]?.body ?? ''}
              onCancel={() => setPublishing(false)}
              onPublished={() => {
                setPublishing(false);
                void load();
                onChanged();
              }}
            />
          )}

          <section aria-labelledby="agt-versions-heading" className="space-y-2">
            <h3 id="agt-versions-heading" className="text-xl">Versions</h3>
            {t.versions.length === 0 && <p className="text-sm text-gray-600">No versions yet. Customers are not asked to accept this agreement until one is in effect.</p>}
            {t.versions.map((v) => (
              <details key={v.id} className="rounded-lg border p-3" open={v.id === current?.id}>
                <summary className="cursor-pointer">
                  <span className="font-black">Version {v.version_number}</span>{' '}
                  <span className="text-sm text-gray-600">
                    {v.effective_from > nowIso ? 'takes effect' : 'in effect from'} {formatLondon(v.effective_from)}
                    {v.id === current?.id ? ' · current' : ''} · accepted {v.acceptance_count} time{v.acceptance_count === 1 ? '' : 's'}
                  </span>
                  {v.change_note && <span className="block text-sm text-gray-600">{v.change_note}</span>}
                </summary>
                {v.body.trim() && <div className="mt-2 max-h-72 overflow-y-auto rounded border bg-white p-3"><AgreementText body={v.body} /></div>}
                {v.has_pdf && <a className="mt-2 inline-block text-sm font-bold text-scout-purple underline" href={`/api/agreements/versions/${v.id}/pdf`} target="_blank" rel="noopener noreferrer">{v.pdf_name ?? 'PDF'}</a>}
                <p className="mt-1 text-xs text-gray-500">Published {formatLondon(v.created_at)}{v.created_by_name ? ` by ${v.created_by_name}` : ''}</p>
                <p className="break-all text-xs text-gray-400">SHA-256: {v.content_hash}</p>
              </details>
            ))}
          </section>

          <section aria-labelledby="agt-acc-heading">
            <h3 id="agt-acc-heading" className="text-xl">Acceptances</h3>
            {acceptances === null ? (
              <button type="button" className="btn-secondary mt-2" onClick={async () => setAcceptances(await api.get<AcceptanceRow[]>(`/admin/agreements/${t.id}/acceptances`))}>
                Show who has accepted it
              </button>
            ) : acceptances.length === 0 ? (
              <p className="text-sm text-gray-600">Nobody has accepted this agreement yet.</p>
            ) : (
              <ul className="mt-2 divide-y rounded-lg border text-sm">
                {acceptances.map((a) => (
                  <li key={a.id} className="flex flex-wrap justify-between gap-2 px-3 py-2">
                    <span><Link to={`/bookings/${a.booking_id}`} className="font-bold text-scout-purple">{a.booking_reference}</Link> · {a.resource_name} · version {a.version_number}</span>
                    <span className="text-gray-600">{a.accepted_by_name}{a.on_behalf ? ' (for the customer)' : ''}, {formatLondon(a.accepted_at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <HistoryPanel filters={{ entity_id: t.id }} />
        </>
      )}
    </Dialog>
  );
}

function PublishVersion({ templateId, initialBody, onCancel, onPublished }: { templateId: string; initialBody: string; onCancel: () => void; onPublished: () => void }) {
  const [body, setBody] = useState(initialBody);
  const [date, setDate] = useState(londonToday());
  const [time, setTime] = useState('00:00');
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  async function publish(e: React.FormEvent) {
    e.preventDefault();
    if (body.trim().length < 10 && !file.current?.files?.length) {
      setError('Add the agreement wording or attach a PDF.');
      return;
    }
    if (!confirm('Publish this version? It cannot be edited afterwards.')) return;
    setSaving(true);
    setError(null);
    try {
      const form = new FormData();
      form.set('body', body);
      form.set('effective_from', fromLondon(date, time));
      form.set('change_note', note);
      const pdf = file.current?.files?.[0];
      if (pdf) form.set('file', pdf);
      await api.upload(`/admin/agreements/${templateId}/versions`, form);
      onPublished();
    } catch (err) {
      setError(message(err, 'Could not publish the version'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="space-y-3 rounded-xl border-2 border-scout-purple/30 p-4" onSubmit={publish}>
      <h3 className="text-xl">New version</h3>
      <div>
        <div className="flex items-center justify-between">
          <label className="label" htmlFor="agv-body">Wording (optional if you attach a PDF)</label>
          <button type="button" className="text-sm font-bold text-scout-purple" onClick={() => setPreview(!preview)}>{preview ? 'Edit' : 'Preview'}</button>
        </div>
        {preview ? (
          <div className="max-h-72 overflow-y-auto rounded-lg border bg-white p-3"><AgreementText body={body} /></div>
        ) : (
          <textarea id="agv-body" className="input font-mono text-sm" rows={12} maxLength={50000} value={body} onChange={(e) => setBody(e.target.value)} />
        )}
        <p className="mt-1 text-xs text-gray-500">{FORMAT_HELP}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="agv-date">Takes effect on (UK time)</label>
          <input id="agv-date" type="date" className="input" required value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="agv-time">At</label>
          <input id="agv-time" type="time" className="input" required value={time} onChange={(e) => setTime(e.target.value)} />
        </div>
      </div>
      <p className="text-xs text-gray-500">Bookings made from this moment must accept the new version. Existing bookings keep the version they accepted; a change request asks for the new one.</p>
      <div>
        <label className="label" htmlFor="agv-note">What changed (optional)</label>
        <input id="agv-note" className="input" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div>
        <label className="label" htmlFor="agv-file">Attach a PDF (up to 10 MB)</label>
        <p className="mb-1 text-xs text-gray-500">Upload your existing agreement document. Customers open it and confirm they accept it when they book.</p>
        <input id="agv-file" ref={file} type="file" accept="application/pdf" className="block text-sm" />
      </div>
      {error && <ErrorState message={error} />}
      <div className="flex gap-2">
        <button className="btn-primary" disabled={saving}>{saving ? 'Publishing…' : 'Publish version'}</button>
        <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
