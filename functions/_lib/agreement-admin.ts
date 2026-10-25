import type { Env } from './http';
import { error, json, newId, now } from './http';
import type { AuthUser } from './auth';
import { audited, auditStatement } from './audit';
import { versionContentHash } from './agreements';
import { canonicalIso } from './availability-sql';
import { agreementVersionSchema, type AgreementTemplateInput } from '@shared/validation';

const MAX_PDF = 10 * 1024 * 1024; // 10 MB

/** Create or update a template and which resources it is assigned to. */
export async function saveTemplate(env: Env, user: AuthUser, input: AgreementTemplateInput, existingId: string | null): Promise<Response> {
  const resourceIds = [...new Set(input.resource_ids)];
  if (resourceIds.length) {
    const found = await env.DB.prepare(`SELECT COUNT(*) AS n FROM resources WHERE id IN (${resourceIds.map(() => '?').join(', ')})`).bind(...resourceIds).first<{ n: number }>();
    if (found?.n !== resourceIds.length) return error('Unknown resource', 400);
  }
  const id = existingId ?? newId('agt');
  const ts = now();
  const before = existingId
    ? (await env.DB.prepare('SELECT resource_id FROM resource_agreements WHERE template_id = ? ORDER BY resource_id').bind(id).all<{ resource_id: string }>()).results.map((r) => r.resource_id)
    : [];
  const write = existingId
    ? env.DB.prepare('UPDATE agreement_templates SET title = ?, summary = ?, applies_to_all = ?, is_active = ?, updated_at = ? WHERE id = ?')
        .bind(input.title, input.summary, input.applies_to_all ? 1 : 0, input.is_active ? 1 : 0, ts, id)
    : env.DB.prepare('INSERT INTO agreement_templates (id, title, summary, applies_to_all, is_active, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, input.title, input.summary, input.applies_to_all ? 1 : 0, input.is_active ? 1 : 0, user.id, ts, ts);
  await audited(env, { actor: user, action: existingId ? 'agreement.updated' : 'agreement.created', table: 'agreement_templates', id }, () => write.run());

  const after = [...resourceIds].sort();
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM resource_agreements WHERE template_id = ?').bind(id),
      ...after.map((r) => env.DB.prepare('INSERT INTO resource_agreements (resource_id, template_id, created_at) VALUES (?, ?, ?)').bind(r, id, ts)),
      auditStatement(env, {
        actor: user,
        action: 'agreement.resources_changed',
        entityType: 'agreement',
        entityId: id,
        entityLabel: input.title,
        before: existingId ? { resource_ids: before } : null,
        after: { resource_ids: after },
      }),
    ]);
  }
  return json({ id }, existingId ? 200 : 201);
}


/**
 * Publish a new version (FR20 §5.2). Versions are immutable: the wording a
 * customer accepted can always be shown again exactly. JSON, or
 * multipart/form-data with fields body, effective_from, change_note and an
 * optional PDF in `file`.
 */
export async function publishVersion(env: Env, user: AuthUser, templateId: string, request: Request): Promise<Response> {
  const template = await env.DB.prepare('SELECT id, title FROM agreement_templates WHERE id = ?').bind(templateId).first<{ id: string; title: string }>();
  if (!template) return error('Agreement not found', 404);

  let fields: unknown;
  let file: File | null = null;
  const type = request.headers.get('content-type') ?? '';
  try {
    if (type.includes('multipart/form-data')) {
      const form = await request.formData();
      fields = { body: form.get('body') ?? undefined, effective_from: form.get('effective_from'), change_note: form.get('change_note') ?? '' };
      const f = form.get('file');
      if (f instanceof File && f.size > 0) file = f;
    } else {
      fields = await request.json();
    }
  } catch {
    return error('Invalid request body', 400);
  }
  const parsed = agreementVersionSchema.safeParse(fields);
  if (!parsed.success) return error('Validation failed', 400, parsed.error.flatten());

  // A version is its wording, its PDF, or both.
  if (parsed.data.body.length < 10 && !file) return error('Add the agreement wording (at least 10 characters) or attach a PDF', 400, { code: 'no_content' });

  let pdf: { key: string; name: string; sha: string } | null = null;
  if (file) {
    if (file.type !== 'application/pdf') return error('Only PDF documents can be attached', 400);
    if (file.size > MAX_PDF) return error('The PDF must be 10 MB or smaller', 400);
    const bytes = await file.arrayBuffer();
    // A real PDF starts with %PDF.
    if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') return error('This file is not a PDF', 400);
    const hex = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const key = `agreements/${templateId}/${newId('pdf')}.pdf`;
    await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: 'application/pdf' }, customMetadata: { sha256: hex } });
    pdf = { key, name: file.name.slice(0, 200) || 'agreement.pdf', sha: hex };
  }

  const ts = now();
  const id = newId('agv');
  const body = parsed.data.body;
  const contentHash = await versionContentHash({ title: template.title, body, pdf_sha256: pdf?.sha ?? null });
  const effectiveFrom = canonicalIso(parsed.data.effective_from);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO agreement_versions (id, template_id, version_number, title, body, effective_from, change_note, pdf_key, pdf_name, pdf_sha256, content_hash, created_by, created_at)
       SELECT ?, ?, COALESCE(MAX(version_number), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM agreement_versions WHERE template_id = ?`,
    ).bind(id, templateId, template.title, body, effectiveFrom, parsed.data.change_note, pdf?.key ?? null, pdf?.name ?? null, pdf?.sha ?? null, contentHash, user.id, ts, templateId),
    auditStatement(env, {
      actor: user,
      action: 'agreement.version_published',
      entityType: 'agreement',
      entityId: templateId,
      entityLabel: template.title,
      after: { version_id: id, effective_from: effectiveFrom, content_hash: contentHash, pdf_name: pdf?.name ?? null, change_note: parsed.data.change_note || null },
    }),
  ]);
  const v = await env.DB.prepare('SELECT version_number FROM agreement_versions WHERE id = ?').bind(id).first<{ version_number: number }>();
  return json({ id, version_number: v?.version_number, content_hash: contentHash }, 201);
}

