import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { AgreementText } from './AgreementText';
import { formatLondon } from '@shared/londonTime';

export interface RequiredAgreement {
  template_id: string;
  title: string;
  summary: string;
  version_id: string;
  version_number: number;
  body: string;
  effective_from: string;
  has_pdf: boolean;
  resource_ids: string[];
}

/** What is sent with a booking or change request once everything is accepted. */
export interface AcceptanceValue {
  version_ids: string[];
  accepted: true;
  signed_name: string;
  signature_image: string | null;
}

/** The agreements that apply to booking these resources, kept up to date as the selection changes. */
export function useRequiredAgreements(resourceIds: string[]) {
  const key = [...new Set(resourceIds.filter(Boolean))].sort().join(',');
  const [agreements, setAgreements] = useState<RequiredAgreement[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!key) {
      setAgreements([]);
      return;
    }
    let live = true;
    setAgreements(null);
    api
      .get<RequiredAgreement[]>(`/agreements/required?resource_ids=${encodeURIComponent(key)}`)
      .then((a) => live && setAgreements(a))
      .catch(() => live && setError('Could not load the agreements for this booking'));
    return () => {
      live = false;
    };
  }, [key]);
  return { agreements, setAgreements, error };
}

/**
 * Read-and-accept step (FR20 §5.4): each agreement's text with its own
 * unticked checkbox, then a typed full-name signature and an optional drawn
 * one. Reports a complete acceptance, or null while anything is missing.
 */
export function AgreementAcceptance({
  agreements,
  onChange,
  idPrefix = 'agr',
  signLabel = 'Type your full name to sign',
}: {
  agreements: RequiredAgreement[];
  onChange: (value: AcceptanceValue | null) => void;
  idPrefix?: string;
  signLabel?: string;
}) {
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [name, setName] = useState('');
  const [drawn, setDrawn] = useState<string | null>(null);
  const versionKey = agreements.map((a) => a.version_id).join(',');

  // A different set of agreements (another resource, a newer version) is accepted afresh.
  useEffect(() => {
    setTicked(new Set());
  }, [versionKey]);

  useEffect(() => {
    const complete = agreements.length > 0 && agreements.every((a) => ticked.has(a.version_id)) && name.trim().length >= 2;
    onChange(complete ? { version_ids: agreements.map((a) => a.version_id), accepted: true, signed_name: name.trim(), signature_image: drawn } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticked, name, drawn, versionKey]);

  if (!agreements.length) return null;

  const toggle = (id: string, on: boolean) => {
    const next = new Set(ticked);
    if (on) next.add(id);
    else next.delete(id);
    setTicked(next);
  };

  return (
    <section className="space-y-4 rounded-xl border-2 border-scout-purple/30 p-4" aria-labelledby={`${idPrefix}-heading`}>
      <div>
        <h2 id={`${idPrefix}-heading`} className="text-xl">Agreements</h2>
        <p className="text-sm text-gray-600">Please read {agreements.length === 1 ? 'this agreement' : 'each of these agreements'} and confirm you accept {agreements.length === 1 ? 'it' : 'them'}.</p>
      </div>
      {agreements.map((a) => (
        <div key={a.version_id} className="space-y-2">
          <h3 className="font-black">{a.title} <span className="text-sm font-normal text-gray-500">version {a.version_number}, in effect from {formatLondon(a.effective_from, { dateStyle: 'medium' })}</span></h3>
          {a.summary && <p className="text-sm text-gray-600">{a.summary}</p>}
          {a.body.trim() && (
            <div className="max-h-64 overflow-y-auto rounded-lg border bg-white p-3" tabIndex={0} aria-label={`${a.title} text`}>
              <AgreementText body={a.body} />
            </div>
          )}
          {a.has_pdf && (
            <a
              className={a.body.trim() ? 'text-sm font-bold text-scout-purple underline' : 'btn-secondary'}
              href={`/api/agreements/versions/${a.version_id}/pdf`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {a.body.trim() ? 'Open the full document (PDF)' : `Read ${a.title} (PDF)`}
            </a>
          )}
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={ticked.has(a.version_id)} onChange={(e) => toggle(a.version_id, e.target.checked)} />
            <span>I have read and accept <strong>{a.title}</strong> (version {a.version_number}).</span>
          </label>
        </div>
      ))}
      <div>
        <label className="label" htmlFor={`${idPrefix}-name`}>{signLabel}</label>
        <input id={`${idPrefix}-name`} className="input" autoComplete="name" maxLength={160} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <details>
        <summary className="cursor-pointer text-sm font-bold">Add a drawn signature (optional)</summary>
        <SignaturePad onChange={setDrawn} />
      </details>
    </section>
  );
}

/** A small drawing area for a signature, saved as a PNG. */
function SignaturePad({ onChange }: { onChange: (dataUrl: string | null) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const inked = useRef(false);
  const [empty, setEmpty] = useState(true);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = canvas.current!;
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height };
  };

  const start = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    canvas.current!.setPointerCapture(e.pointerId);
    drawing.current = true;
    const p = point(e);
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#1b1b1b';
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const ctx = canvas.current!.getContext('2d')!;
    const p = point(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    inked.current = true;
    setEmpty(false);
  };
  const end = () => {
    if (!drawing.current) return;
    drawing.current = false;
    if (inked.current) onChange(canvas.current!.toDataURL('image/png'));
  };
  const clear = () => {
    const c = canvas.current!;
    c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
    inked.current = false;
    setEmpty(true);
    onChange(null);
  };

  return (
    <div className="mt-2 space-y-2">
      <canvas
        ref={canvas}
        width={480}
        height={140}
        className="h-32 w-full touch-none rounded-lg border bg-white"
        aria-label="Signature drawing area. Draw with a mouse, finger or stylus."
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerLeave={end}
      />
      <button type="button" className="btn-secondary" onClick={clear} disabled={empty}>Clear signature</button>
    </div>
  );
}
