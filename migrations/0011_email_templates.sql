-- Release 2 / FR06: editable email templates and email history.
-- Default template content lives in code (src/shared/email-templates.ts). A row
-- here is an administrator's saved version, and deleting it restores the
-- default.

CREATE TABLE email_templates (
  key         TEXT PRIMARY KEY,
  subject     TEXT NOT NULL,
  body_text   TEXT NOT NULL,
  body_html   TEXT,
  is_enabled  INTEGER NOT NULL DEFAULT 1,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT REFERENCES users(id)
);

-- History: what was sent, the provider's reference, and retry state. params
-- holds the template parameters only while a failed send awaits a retry.
ALTER TABLE email_events ADD COLUMN subject TEXT;
ALTER TABLE email_events ADD COLUMN booking_reference TEXT;
ALTER TABLE email_events ADD COLUMN provider_ref TEXT;
ALTER TABLE email_events ADD COLUMN sent_at TEXT;
ALTER TABLE email_events ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1;
ALTER TABLE email_events ADD COLUMN next_attempt_at TEXT;
ALTER TABLE email_events ADD COLUMN params TEXT;

-- Release 1 rows that were sent: their creation time is the best sending time.
UPDATE email_events SET sent_at = created_at WHERE status = 'sent';

CREATE INDEX idx_email_events_retry ON email_events(status, next_attempt_at);
CREATE INDEX idx_email_events_created ON email_events(created_at);
