-- ===========================================================================
-- Release 3 / FR20: booking agreements and digital acceptance.
--
-- An agreement template (for example "Hire conditions" or "Fire safety
-- briefing") has numbered versions. A version is never edited once saved:
-- changing the wording means adding a new version with its own effective
-- date. Templates apply to every booking, or to the resources they are
-- assigned to (and everything that is part of those resources).
--
-- When a customer books, they accept the version of each applicable
-- agreement that is in effect, by ticking an unticked box for each and
-- typing their full name (a drawn signature is optional). Each acceptance
-- records the exact version and a SHA-256 hash of its content, and like the
-- versions it cannot be changed or deleted afterwards.
--
-- No agreements are seeded, so bookings work exactly as before until an
-- administrator publishes one. Safe to apply before the code is deployed.
-- ===========================================================================

CREATE TABLE agreement_templates (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  summary        TEXT NOT NULL DEFAULT '',             -- one line shown in the booking form
  applies_to_all INTEGER NOT NULL DEFAULT 0,           -- every booking, whatever the resource
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE agreement_versions (
  id              TEXT PRIMARY KEY,
  template_id     TEXT NOT NULL REFERENCES agreement_templates(id),
  version_number  INTEGER NOT NULL,
  title           TEXT NOT NULL,                       -- the title as it was when this version was published
  body            TEXT NOT NULL,                       -- formatted text: paragraphs, headings, lists, bold, links
  effective_from  TEXT NOT NULL,                       -- ISO instant from which new bookings must accept it
  change_note     TEXT NOT NULL DEFAULT '',
  -- Optional PDF kept in R2, served only to signed-in users.
  pdf_key         TEXT,
  pdf_name        TEXT,
  pdf_sha256      TEXT,
  content_hash    TEXT NOT NULL,                       -- SHA-256 of title, body and PDF hash
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  UNIQUE (template_id, version_number)
);
CREATE INDEX idx_agreement_versions_effective ON agreement_versions(template_id, effective_from);

CREATE TRIGGER agreement_versions_no_update BEFORE UPDATE ON agreement_versions
BEGIN
  SELECT RAISE(ABORT, 'Agreement versions cannot be changed. Publish a new version instead.');
END;
CREATE TRIGGER agreement_versions_no_delete BEFORE DELETE ON agreement_versions
BEGIN
  SELECT RAISE(ABORT, 'Agreement versions cannot be deleted.');
END;

CREATE TABLE resource_agreements (
  resource_id  TEXT NOT NULL REFERENCES resources(id),
  template_id  TEXT NOT NULL REFERENCES agreement_templates(id),
  created_at   TEXT NOT NULL,
  PRIMARY KEY (resource_id, template_id)
);
CREATE INDEX idx_resource_agreements_template ON resource_agreements(template_id);

-- One signature per act of accepting (a booking, a group of bookings, a
-- recurring series or a change request), shared by its acceptances.
CREATE TABLE agreement_signatures (
  id              TEXT PRIMARY KEY,
  signed_by       TEXT NOT NULL,                       -- the signed-in user who accepted
  on_behalf_of    TEXT,                                -- the customer, when an administrator booked for them
  signed_name     TEXT NOT NULL,                       -- the full name they typed
  signature_image TEXT,                                -- optional drawn signature, a PNG data URL
  created_at      TEXT NOT NULL
);

CREATE TABLE agreement_acceptances (
  id            TEXT PRIMARY KEY,
  booking_id    TEXT NOT NULL REFERENCES bookings(id),
  amendment_id  TEXT,                                  -- set when accepted for a change request
  template_id   TEXT NOT NULL,
  version_id    TEXT NOT NULL REFERENCES agreement_versions(id),
  content_hash  TEXT NOT NULL,                         -- copied from the version at acceptance
  signature_id  TEXT NOT NULL REFERENCES agreement_signatures(id),
  accepted_by   TEXT NOT NULL,
  accepted_at   TEXT NOT NULL
);
CREATE INDEX idx_agreement_acceptances_booking ON agreement_acceptances(booking_id);
CREATE INDEX idx_agreement_acceptances_version ON agreement_acceptances(version_id);

CREATE TRIGGER agreement_signatures_no_update BEFORE UPDATE ON agreement_signatures
BEGIN
  SELECT RAISE(ABORT, 'Signatures cannot be changed.');
END;
CREATE TRIGGER agreement_signatures_no_delete BEFORE DELETE ON agreement_signatures
BEGIN
  SELECT RAISE(ABORT, 'Signatures cannot be deleted.');
END;
CREATE TRIGGER agreement_acceptances_no_update BEFORE UPDATE ON agreement_acceptances
BEGIN
  SELECT RAISE(ABORT, 'Agreement acceptances cannot be changed.');
END;
CREATE TRIGGER agreement_acceptances_no_delete BEFORE DELETE ON agreement_acceptances
BEGIN
  SELECT RAISE(ABORT, 'Agreement acceptances cannot be deleted.');
END;

-- Every acceptance is also in the audit history.
CREATE TRIGGER agreement_acceptances_audit AFTER INSERT ON agreement_acceptances
BEGIN
  INSERT INTO audit_events (id, created_at, actor_id, actor_type, action, entity_type, entity_id, entity_label,
                            before_json, after_json, reason, booking_id, organisation_id, resource_id)
  SELECT 'aud_' || NEW.id, NEW.accepted_at, NEW.accepted_by,
         CASE WHEN EXISTS (SELECT 1 FROM user_roles WHERE user_id = NEW.accepted_by) THEN 'administrator' ELSE 'customer' END,
         'agreement.accepted', 'agreement_acceptance', NEW.id, v.title || ' (version ' || v.version_number || ')',
         NULL,
         json_object('version_id', NEW.version_id, 'content_hash', NEW.content_hash, 'amendment_id', NEW.amendment_id,
                     'on_behalf_of', s.on_behalf_of, 'drawn_signature', CASE WHEN s.signature_image IS NULL THEN 0 ELSE 1 END),
         NULL, NEW.booking_id, b.organisation_id, b.resource_id
  FROM agreement_versions v, bookings b, agreement_signatures s
  WHERE v.id = NEW.version_id AND b.id = NEW.booking_id AND s.id = NEW.signature_id;
END;

INSERT INTO permissions (key, description) VALUES
  ('agreements.manage', 'Create agreement templates, publish versions and assign them to resources');

INSERT INTO role_permissions (role_id, permission_key) VALUES
  ('role_super_admin', 'agreements.manage');
