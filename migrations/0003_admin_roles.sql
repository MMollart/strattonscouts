-- ===========================================================================
-- Release 2 / FR08: granular administration roles and permissions.
-- Non-destructive: the Release 1 'admin' role is renamed in place to
-- 'booking_admin' (same id, so every existing user_roles row keeps working)
-- and two roles are added. Permissions are data, mapped to roles in
-- role_permissions, and checked server-side on every admin API.
-- ===========================================================================

UPDATE roles
SET name = 'booking_admin',
    description = 'Day-to-day bookings, availability, resources and assets'
WHERE id = 'role_admin';

UPDATE roles
SET description = 'Full administrative access incl. pricing, templates, administrators and settings'
WHERE id = 'role_super_admin';

INSERT INTO roles (id, name, description) VALUES
  ('role_viewer', 'viewer', 'Read-only access to bookings and financial information');

CREATE TABLE permissions (
  key         TEXT PRIMARY KEY,
  description TEXT NOT NULL
);

CREATE TABLE role_permissions (
  role_id        TEXT NOT NULL,
  permission_key TEXT NOT NULL,
  PRIMARY KEY (role_id, permission_key),
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
  FOREIGN KEY (permission_key) REFERENCES permissions(key) ON DELETE CASCADE
);

INSERT INTO permissions (key, description) VALUES
  ('bookings.view',          'View bookings, customers and organisations'),
  ('bookings.create',        'Create bookings on behalf of customers'),
  ('bookings.approve',       'Approve or reject bookings and amendments'),
  ('bookings.manage',        'Amend or cancel bookings and correct customer categories'),
  ('availability.manage',    'Manage closures, availability rules and booking overrides'),
  ('resources.manage',       'Manage resources, images and the conflict matrix'),
  ('pricing.manage',         'Manage prices, discounts and organisation pricing'),
  ('assets.manage',          'Manage physical assets and assignments'),
  ('email_templates.manage', 'Edit, preview and test email templates'),
  ('finance.view',           'View booking prices and amounts'),
  ('admins.manage',          'Assign, change and revoke administrator roles'),
  ('settings.manage',        'Manage application settings');

-- Super Admin: everything.
INSERT INTO role_permissions (role_id, permission_key)
  SELECT 'role_super_admin', key FROM permissions;

-- Booking Admin.
INSERT INTO role_permissions (role_id, permission_key) VALUES
  ('role_admin', 'bookings.view'),
  ('role_admin', 'bookings.create'),
  ('role_admin', 'bookings.approve'),
  ('role_admin', 'bookings.manage'),
  ('role_admin', 'availability.manage'),
  ('role_admin', 'resources.manage'),
  ('role_admin', 'assets.manage'),
  ('role_admin', 'finance.view');

-- Viewer: read-only.
INSERT INTO role_permissions (role_id, permission_key) VALUES
  ('role_viewer', 'bookings.view'),
  ('role_viewer', 'finance.view');

-- Application settings (key/value), managed by Super Admins.
CREATE TABLE app_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT
);

INSERT INTO app_settings (key, value, updated_at) VALUES
  ('venue_name',    'Stratton Scouts', '2026-10-15T00:00:00.000Z'),
  ('contact_email', 'bookings@strattonscouts.example', '2026-10-15T00:00:00.000Z');

-- Audit trail of administrator role changes.
CREATE TABLE admin_role_events (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  from_role   TEXT,
  to_role     TEXT,
  actor_id    TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_admin_role_events_user ON admin_role_events(user_id);

-- Transaction guard. A batch that must be all-or-nothing includes
--   INSERT INTO txn_guard (ok) SELECT 0 WHERE <condition that must not hold>
-- which violates the CHECK when the condition holds, so D1 rolls back the
-- whole batch. The table never holds rows.
CREATE TABLE txn_guard (ok INTEGER NOT NULL CHECK (ok = 1));
