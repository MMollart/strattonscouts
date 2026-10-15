import { useState } from 'react';
import { useApi } from '../lib/useApi';
import { ErrorState } from './ui';

export interface OrganisationDraft {
  name: string;
  organisation_type_id: string;
  pricing_category_id: string;
  contact_email: string;
  contact_phone: string;
}

interface Option { id: string; label: string; }

export const EMPTY_ORGANISATION: OrganisationDraft = {
  name: '', organisation_type_id: 'scout_group', pricing_category_id: '', contact_email: '', contact_phone: '',
};

/** Create / edit form for an organisation's details. */
export function OrganisationForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: OrganisationDraft;
  submitLabel: string;
  onSubmit: (draft: OrganisationDraft) => Promise<void>;
  onCancel?: () => void;
}) {
  const { data: types } = useApi<Option[]>('/organisation-types');
  const { data: categories } = useApi<Option[]>('/categories');
  const [draft, setDraft] = useState<OrganisationDraft>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<OrganisationDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const categoryId = draft.pricing_category_id || categories?.[0]?.id || '';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSubmit({ ...draft, pricing_category_id: categoryId });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={submit}>
      <div>
        <label className="label" htmlFor="org-name">Organisation name</label>
        <input id="org-name" className="input" value={draft.name} onChange={(e) => set({ name: e.target.value })} required minLength={2} maxLength={120} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="org-type">Organisation type</label>
          <select id="org-type" className="input" value={draft.organisation_type_id} onChange={(e) => set({ organisation_type_id: e.target.value })}>
            {types?.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="org-cat">Customer pricing category</label>
          <select id="org-cat" className="input" value={categoryId} onChange={(e) => set({ pricing_category_id: e.target.value })}>
            {categories?.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="org-email">Contact email</label>
          <input id="org-email" type="email" className="input" value={draft.contact_email} onChange={(e) => set({ contact_email: e.target.value })} required />
        </div>
        <div>
          <label className="label" htmlFor="org-phone">Contact telephone</label>
          <input id="org-phone" className="input" value={draft.contact_phone} onChange={(e) => set({ contact_phone: e.target.value })} required minLength={5} />
        </div>
      </div>
      <p className="text-xs text-gray-500">Administrators may check and correct the pricing category.</p>
      {error && <ErrorState message={error} />}
      <div className="flex gap-2">
        <button className="btn-primary" disabled={saving}>{saving ? 'Saving…' : submitLabel}</button>
        {onCancel && <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}
