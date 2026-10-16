-- Emails are built from five sections (title, body, detail card, thanks,
-- footer) inside the branded layout. A saved template keeps its sections
-- here; body_text holds the plain-text version and body_html is no longer
-- used. Saved templates from before this change have no title, so they fall
-- back to the defaults (keeping whether they are switched on).
-- Adding columns only, so this is safe to run before the code deploys.

ALTER TABLE email_templates ADD COLUMN title TEXT;
ALTER TABLE email_templates ADD COLUMN body TEXT;
ALTER TABLE email_templates ADD COLUMN detail_card TEXT;
ALTER TABLE email_templates ADD COLUMN thanks TEXT;
ALTER TABLE email_templates ADD COLUMN footer TEXT;
