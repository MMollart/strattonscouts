-- ===========================================================================
-- Release 3 / FR22: resource maintenance and fault management.
--
-- Maintenance and faults never get an availability engine of their own. A
-- record that blocks availability owns a row in resource_closures (linked by
-- maintenance_id or fault_id), so the existing closure checks, the resource
-- hierarchy (Whole Venue > Building > Main Hall ...) and the public calendar
-- apply to it exactly as they do to any closure. The application keeps that
-- row in step with the record: it exists while the maintenance is planned or
-- in progress (or the fault is open), and is removed when the work is
-- completed or cancelled.
--
-- Records are never deleted; completed and cancelled ones stay as history.
-- Safe to apply before the code that uses it is deployed.
-- ===========================================================================

CREATE TABLE maintenance_types (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL UNIQUE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

INSERT INTO maintenance_types (id, label, sort_order, created_at, updated_at) VALUES
  ('mtype_planned',    'Planned maintenance',   1, '2026-10-16T00:00:00.000Z', '2026-10-16T00:00:00.000Z'),
  ('mtype_emergency',  'Emergency maintenance', 2, '2026-10-16T00:00:00.000Z', '2026-10-16T00:00:00.000Z'),
  ('mtype_repair',     'Repair',                3, '2026-10-16T00:00:00.000Z', '2026-10-16T00:00:00.000Z'),
  ('mtype_inspection', 'Inspection',            4, '2026-10-16T00:00:00.000Z', '2026-10-16T00:00:00.000Z'),
  ('mtype_cleaning',   'Cleaning',              5, '2026-10-16T00:00:00.000Z', '2026-10-16T00:00:00.000Z'),
  ('mtype_other',      'Other maintenance',     6, '2026-10-16T00:00:00.000Z', '2026-10-16T00:00:00.000Z');

CREATE TABLE maintenance_records (
  id                  TEXT PRIMARY KEY,
  reference           TEXT NOT NULL UNIQUE,              -- e.g. MNT-7F3K9Q
  resource_id         TEXT NOT NULL,
  maintenance_type_id TEXT NOT NULL,
  title               TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  starts_at           TEXT NOT NULL,
  ends_at             TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('planned', 'in_progress', 'completed', 'cancelled')),
  blocks_availability INTEGER NOT NULL DEFAULT 1,
  assigned_admin_id   TEXT,
  notes               TEXT NOT NULL DEFAULT '',
  -- Set when an administrator saved blocking maintenance over existing bookings.
  conflict_exception_reason TEXT,
  created_by          TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  CHECK (ends_at > starts_at),
  FOREIGN KEY (resource_id) REFERENCES resources(id),
  FOREIGN KEY (maintenance_type_id) REFERENCES maintenance_types(id)
);
CREATE INDEX idx_maintenance_resource_time ON maintenance_records(resource_id, starts_at, ends_at);
CREATE INDEX idx_maintenance_status ON maintenance_records(status);

-- Existing bookings a blocking maintenance period overlapped when it was saved.
-- They are never cancelled automatically; each needs an administrator to act.
CREATE TABLE maintenance_affected_bookings (
  maintenance_id  TEXT NOT NULL,
  booking_id      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'needs_action' CHECK (status IN ('needs_action', 'resolved')),
  resolution_note TEXT,
  notified_at     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (maintenance_id, booking_id),
  FOREIGN KEY (maintenance_id) REFERENCES maintenance_records(id),
  FOREIGN KEY (booking_id) REFERENCES bookings(id)
);
CREATE INDEX idx_maintenance_affected_booking ON maintenance_affected_bookings(booking_id);

CREATE TABLE resource_faults (
  id               TEXT PRIMARY KEY,
  reference        TEXT NOT NULL UNIQUE,                 -- e.g. FLT-7F3K9Q
  resource_id      TEXT NOT NULL,
  description      TEXT NOT NULL,
  severity         TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  status           TEXT NOT NULL CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  blocks_bookings  INTEGER NOT NULL DEFAULT 0,
  reported_at      TEXT NOT NULL,
  reported_by      TEXT NOT NULL,
  resolution_notes TEXT NOT NULL DEFAULT '',
  resolved_at      TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  FOREIGN KEY (resource_id) REFERENCES resources(id)
);
CREATE INDEX idx_resource_faults_resource ON resource_faults(resource_id, status);

-- The closure a blocking maintenance record or fault owns.
ALTER TABLE resource_closures ADD COLUMN maintenance_id TEXT REFERENCES maintenance_records(id);
ALTER TABLE resource_closures ADD COLUMN fault_id TEXT REFERENCES resource_faults(id);
CREATE UNIQUE INDEX idx_resource_closures_maintenance ON resource_closures(maintenance_id) WHERE maintenance_id IS NOT NULL;
CREATE UNIQUE INDEX idx_resource_closures_fault ON resource_closures(fault_id) WHERE fault_id IS NOT NULL;

INSERT INTO permissions (key, description) VALUES
  ('maintenance.manage', 'Schedule maintenance, report and manage faults, and notify affected customers');

INSERT INTO role_permissions (role_id, permission_key) VALUES
  ('role_super_admin', 'maintenance.manage'),
  ('role_admin',       'maintenance.manage');
