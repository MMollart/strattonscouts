-- ===========================================================================
-- Release 3 / FR11: booking and administration audit history.
--
-- audit_events is one append-only log of significant changes: who did what,
-- when, to which record, the values before and after, and why. It has no
-- foreign keys so history outlives the records it describes.
--
-- Integrity:
--   * Triggers refuse DELETE, and refuse UPDATE except the one-off "seal" that
--     fills in prev_hash/hash on a row that has none yet.
--   * Sealing (functions/_lib/audit.ts) chains each row's SHA-256 hash to the
--     previous row's, so editing or removing a sealed row is detectable by
--     Admin > Audit history > Check integrity.
--   * Someone with direct database access can still drop the triggers and
--     rewrite the chain. The log is tamper-evident, not immutable.
--
-- booking_events and admin_role_events (Releases 1-2) are copied in, and
-- triggers copy every new row of theirs, so every booking lifecycle change and
-- administrator role change is audited in the same transaction as the change.
--
-- Safe to apply before the code that uses it is deployed.
-- ===========================================================================

CREATE TABLE audit_events (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT NOT NULL UNIQUE,
  created_at      TEXT NOT NULL,
  actor_id        TEXT,                -- users.id, or NULL for automated (system) actions
  actor_type      TEXT NOT NULL CHECK (actor_type IN ('customer', 'administrator', 'system')),
  action          TEXT NOT NULL,       -- e.g. booking.approved, pricing.rate_updated
  entity_type     TEXT NOT NULL,       -- e.g. booking, resource, base_rate
  entity_id       TEXT NOT NULL,
  entity_label    TEXT,                -- a readable name at the time, e.g. a booking reference
  before_json     TEXT,                -- changed fields before (JSON object), NULL on create
  after_json      TEXT,                -- changed fields after (JSON object), NULL on delete
  reason          TEXT,
  booking_id      TEXT,
  organisation_id TEXT,
  resource_id     TEXT,
  prev_hash       TEXT,
  hash            TEXT
);
CREATE INDEX idx_audit_events_created ON audit_events(created_at);
CREATE INDEX idx_audit_events_entity ON audit_events(entity_type, entity_id);
CREATE INDEX idx_audit_events_booking ON audit_events(booking_id) WHERE booking_id IS NOT NULL;
CREATE INDEX idx_audit_events_organisation ON audit_events(organisation_id) WHERE organisation_id IS NOT NULL;
CREATE INDEX idx_audit_events_resource ON audit_events(resource_id) WHERE resource_id IS NOT NULL;
CREATE INDEX idx_audit_events_actor ON audit_events(actor_id);
CREATE INDEX idx_audit_events_unsealed ON audit_events(seq) WHERE hash IS NULL;

CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;

CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
WHEN OLD.hash IS NOT NULL
  OR NEW.seq IS NOT OLD.seq OR NEW.id IS NOT OLD.id OR NEW.created_at IS NOT OLD.created_at
  OR NEW.actor_id IS NOT OLD.actor_id OR NEW.actor_type IS NOT OLD.actor_type OR NEW.action IS NOT OLD.action
  OR NEW.entity_type IS NOT OLD.entity_type OR NEW.entity_id IS NOT OLD.entity_id OR NEW.entity_label IS NOT OLD.entity_label
  OR NEW.before_json IS NOT OLD.before_json OR NEW.after_json IS NOT OLD.after_json OR NEW.reason IS NOT OLD.reason
  OR NEW.booking_id IS NOT OLD.booking_id OR NEW.organisation_id IS NOT OLD.organisation_id OR NEW.resource_id IS NOT OLD.resource_id
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;

-- Existing history, oldest first so seq follows time.
INSERT INTO audit_events (id, created_at, actor_id, actor_type, action, entity_type, entity_id, entity_label, before_json, after_json, reason, booking_id, organisation_id, resource_id)
SELECT id, created_at, actor_id, actor_type, action, entity_type, entity_id, entity_label, before_json, after_json, reason, booking_id, organisation_id, resource_id
FROM (
  SELECT 'aud_' || e.id AS id, e.created_at, e.actor_id,
         CASE WHEN e.actor_id IS NULL THEN 'system'
              WHEN EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = e.actor_id) THEN 'administrator'
              ELSE 'customer' END AS actor_type,
         'booking.' || e.event_type AS action, 'booking' AS entity_type, e.booking_id AS entity_id, b.reference AS entity_label,
         CASE WHEN json_valid(e.detail) THEN json_extract(e.detail, '$.from') END AS before_json,
         CASE WHEN json_valid(e.detail) AND json_extract(e.detail, '$.to') IS NOT NULL THEN json_extract(e.detail, '$.to')
              WHEN e.event_type IN ('created', 'confirmed', 'provisional') THEN json_object('resource_id', b.resource_id, 'starts_at', b.starts_at, 'ends_at', b.ends_at, 'total_amount_pence', b.total_amount_pence)
              ELSE json_object('status', e.event_type) END AS after_json,
         CASE WHEN json_valid(e.detail) THEN json_extract(e.detail, '$.note') END AS reason,
         e.booking_id, b.organisation_id, b.resource_id
  FROM booking_events e LEFT JOIN bookings b ON b.id = e.booking_id
  UNION ALL
  SELECT 'aud_' || a.id, a.created_at, a.actor_id, 'administrator', 'admin.role_changed', 'user', a.user_id, NULL,
         json_object('role', a.from_role), json_object('role', a.to_role), NULL, NULL, NULL, NULL
  FROM admin_role_events a
)
ORDER BY created_at, id;

-- Every new booking lifecycle event. A booking_events.detail JSON may carry
-- "from"/"to" objects (the changed values) and a "note" (the reason).
CREATE TRIGGER booking_events_audit AFTER INSERT ON booking_events
BEGIN
  INSERT INTO audit_events (id, created_at, actor_id, actor_type, action, entity_type, entity_id, entity_label, before_json, after_json, reason, booking_id, organisation_id, resource_id)
  SELECT 'aud_' || NEW.id, NEW.created_at, NEW.actor_id,
         CASE WHEN NEW.actor_id IS NULL THEN 'system'
              WHEN EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = NEW.actor_id) THEN 'administrator'
              ELSE 'customer' END,
         'booking.' || NEW.event_type, 'booking', NEW.booking_id, b.reference,
         CASE WHEN json_valid(NEW.detail) THEN json_extract(NEW.detail, '$.from') END,
         CASE WHEN json_valid(NEW.detail) AND json_extract(NEW.detail, '$.to') IS NOT NULL THEN json_extract(NEW.detail, '$.to')
              WHEN NEW.event_type IN ('created', 'confirmed', 'provisional') THEN json_object('resource_id', b.resource_id, 'starts_at', b.starts_at, 'ends_at', b.ends_at, 'total_amount_pence', b.total_amount_pence)
              ELSE json_object('status', b.status) END,
         CASE WHEN json_valid(NEW.detail) THEN json_extract(NEW.detail, '$.note') END,
         NEW.booking_id, b.organisation_id, b.resource_id
  FROM (SELECT 1) LEFT JOIN bookings b ON b.id = NEW.booking_id;
END;

CREATE TRIGGER admin_role_events_audit AFTER INSERT ON admin_role_events
BEGIN
  INSERT INTO audit_events (id, created_at, actor_id, actor_type, action, entity_type, entity_id, before_json, after_json)
  VALUES ('aud_' || NEW.id, NEW.created_at, NEW.actor_id, 'administrator', 'admin.role_changed', 'user', NEW.user_id,
          json_object('role', NEW.from_role), json_object('role', NEW.to_role));
END;

INSERT INTO permissions (key, description) VALUES
  ('audit.view',   'View the full audit history, including changed values'),
  ('audit.export', 'Export the audit history to CSV');

INSERT INTO role_permissions (role_id, permission_key) VALUES
  ('role_super_admin', 'audit.view'),
  ('role_super_admin', 'audit.export'),
  ('role_admin',       'audit.view');
