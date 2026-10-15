import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { Spinner, ErrorState } from '../../components/ui';
import type { SettingDefinition } from '@shared/settings';

type SettingRow = SettingDefinition & { value: string };

export default function AdminSettings() {
  const { data, loading, error } = useApi<SettingRow[]>('/admin/settings');
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (data) setValues(Object.fromEntries(data.map((d) => [d.key, d.value])));
  }, [data]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      await api.put('/admin/settings', { values });
      setMessage({ kind: 'ok', text: 'Settings saved.' });
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof ApiError ? err.message : 'Could not save settings' });
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <Spinner />;
  if (error) return <ErrorState message={error} />;

  return (
    <div className="mx-auto max-w-2xl">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl">Settings</h1>
        <Link to="/admin" className="text-sm font-bold text-scout-purple">← Dashboard</Link>
      </div>
      <form className="card mt-6 space-y-4" onSubmit={save}>
        {data?.map((d) => (
          <div key={d.key}>
            <label className="label" htmlFor={`set-${d.key}`}>{d.label}</label>
            <input
              id={`set-${d.key}`}
              className="input"
              type={d.type === 'integer' ? 'number' : d.type}
              min={d.min}
              max={d.max}
              value={values[d.key] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [d.key]: e.target.value }))}
              required
            />
            {d.help && <p className="mt-1 text-xs text-gray-500">{d.help}</p>}
          </div>
        ))}
        {message && (
          <p className={`text-sm font-bold ${message.kind === 'ok' ? 'text-scout-green' : 'text-scout-red'}`} role={message.kind === 'ok' ? 'status' : 'alert'}>
            {message.text}
          </p>
        )}
        <button className="btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</button>
      </form>
    </div>
  );
}
