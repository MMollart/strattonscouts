-- ===========================================================================
-- Stratton Scouts Booking Platform — Release 1 schema
-- Cloudflare D1 (SQLite). Times stored as ISO-8601 UTC text.
-- Monetary values stored as INTEGER minor units (pence).
-- Designed to accommodate future extensions (organisations, recurring
-- bookings, provisional reservations, payments) without rework.
-- ===========================================================================

-- ------------------------- Users & auth -----------------------------------
CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL UNIQUE,
  full_name         TEXT NOT NULL,
  -- phone stored encrypted at rest (application-level envelope encryption)
  phone_encrypted   TEXT,
  password_hash     TEXT NOT NULL,
  pricing_category_id TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  FOREIGN KEY (pricing_category_id) REFERENCES pricing_categories(id)
);
CREATE INDEX idx_users_email ON users(email);

CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,          -- opaque random id (sent in cookie)
  user_id       TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE password_resets (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  token_hash  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_password_resets_token ON password_resets(token_hash);

-- Basic auth rate limiting (per identifier e.g. ip:email + action)
CREATE TABLE auth_attempts (
  id          TEXT PRIMARY KEY,
  identifier  TEXT NOT NULL,
  action      TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_auth_attempts_lookup ON auth_attempts(identifier, action, created_at);

-- ------------------------- Roles / RBAC -----------------------------------
CREATE TABLE roles (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,        -- 'super_admin' | 'admin'
  description TEXT
);

CREATE TABLE user_roles (
  user_id     TEXT NOT NULL,
  role_id     TEXT NOT NULL,
  granted_at  TEXT NOT NULL,
  granted_by  TEXT,
  PRIMARY KEY (user_id, role_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
);

-- ------------------------- Pricing categories -----------------------------
CREATE TABLE pricing_categories (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,        -- 'scouts' | 'community' | 'public'
  label       TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

-- ------------------------- Resources --------------------------------------
CREATE TABLE resources (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  slug             TEXT NOT NULL UNIQUE,
  description      TEXT NOT NULL DEFAULT '',
  -- 'combined' (e.g. Whole Venue) or 'individual'
  resource_type    TEXT NOT NULL DEFAULT 'individual',
  is_active        INTEGER NOT NULL DEFAULT 1,
  requires_approval INTEGER NOT NULL DEFAULT 0,
  -- pricing model: 'hourly' | 'nightly' | 'fixed'
  pricing_model    TEXT NOT NULL DEFAULT 'hourly',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_resources_active ON resources(is_active);

CREATE TABLE resource_images (
  id            TEXT PRIMARY KEY,
  resource_id   TEXT NOT NULL,
  r2_key        TEXT NOT NULL,             -- object key in R2 (image not stored in DB)
  content_type  TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  is_primary    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  FOREIGN KEY (resource_id) REFERENCES resources(id) ON DELETE CASCADE
);
CREATE INDEX idx_resource_images_resource ON resource_images(resource_id);

-- Configurable, bidirectional conflict matrix.
-- is_mandatory conflicts (self-conflicts, Whole Venue relationships) cannot be removed.
CREATE TABLE resource_conflicts (
  id              TEXT PRIMARY KEY,
  resource_id     TEXT NOT NULL,
  conflicts_with_id TEXT NOT NULL,
  is_mandatory    INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  UNIQUE (resource_id, conflicts_with_id),
  FOREIGN KEY (resource_id) REFERENCES resources(id) ON DELETE CASCADE,
  FOREIGN KEY (conflicts_with_id) REFERENCES resources(id) ON DELETE CASCADE
);
CREATE INDEX idx_resource_conflicts_resource ON resource_conflicts(resource_id);

-- Administratively blocked / unavailable periods.
CREATE TABLE resource_closures (
  id          TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  starts_at   TEXT NOT NULL,
  ends_at     TEXT NOT NULL,
  reason      TEXT,
  created_at  TEXT NOT NULL,
  FOREIGN KEY (resource_id) REFERENCES resources(id) ON DELETE CASCADE
);
CREATE INDEX idx_resource_closures_resource ON resource_closures(resource_id, starts_at, ends_at);

-- ------------------------- Pricing ----------------------------------------
-- Per resource + category price. amount_pence in GBP minor units.
CREATE TABLE resource_pricing (
  id            TEXT PRIMARY KEY,
  resource_id   TEXT NOT NULL,
  category_id   TEXT NOT NULL,
  amount_pence  INTEGER NOT NULL DEFAULT 0,
  is_free       INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL,
  UNIQUE (resource_id, category_id),
  FOREIGN KEY (resource_id) REFERENCES resources(id) ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES pricing_categories(id) ON DELETE CASCADE
);
CREATE INDEX idx_resource_pricing_resource ON resource_pricing(resource_id);

-- ------------------------- Bookings ---------------------------------------
CREATE TABLE bookings (
  id                 TEXT PRIMARY KEY,
  reference          TEXT NOT NULL UNIQUE,  -- human readable e.g. SS-ABC123
  user_id            TEXT NOT NULL,
  resource_id        TEXT NOT NULL,
  starts_at          TEXT NOT NULL,
  ends_at            TEXT NOT NULL,
  -- 'pending_approval' | 'confirmed' | 'rejected' | 'cancelled'
  -- (schema allows future: provisional, expired, completed)
  status             TEXT NOT NULL,
  category_id        TEXT NOT NULL,         -- category applied at booking time
  pricing_model      TEXT NOT NULL,         -- snapshot of pricing model
  unit_price_pence   INTEGER NOT NULL,      -- snapshot of unit price
  total_amount_pence INTEGER NOT NULL,      -- final amount (snapshot)
  approved_by        TEXT,
  cancelled_by       TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (resource_id) REFERENCES resources(id),
  FOREIGN KEY (category_id) REFERENCES pricing_categories(id)
);
CREATE INDEX idx_bookings_resource_time ON bookings(resource_id, starts_at, ends_at);
CREATE INDEX idx_bookings_user ON bookings(user_id);
CREATE INDEX idx_bookings_status ON bookings(status);

-- Associated resource allocations (allows a combined booking to reserve
-- several resources, and supports future multi-resource bookings).
CREATE TABLE booking_resources (
  booking_id  TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  PRIMARY KEY (booking_id, resource_id),
  FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE,
  FOREIGN KEY (resource_id) REFERENCES resources(id)
);
CREATE INDEX idx_booking_resources_resource ON booking_resources(resource_id);

CREATE TABLE booking_events (
  id          TEXT PRIMARY KEY,
  booking_id  TEXT NOT NULL,
  event_type  TEXT NOT NULL,     -- created | confirmed | approved | rejected | cancelled
  actor_id    TEXT,
  detail      TEXT,
  created_at  TEXT NOT NULL,
  FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE
);
CREATE INDEX idx_booking_events_booking ON booking_events(booking_id);

-- ------------------------- Email history ----------------------------------
CREATE TABLE email_events (
  id            TEXT PRIMARY KEY,
  booking_id    TEXT,
  recipient     TEXT NOT NULL,
  template      TEXT NOT NULL,
  -- idempotency key prevents duplicate sends on retry
  dedupe_key    TEXT UNIQUE,
  status        TEXT NOT NULL,   -- sent | failed
  error         TEXT,
  created_at    TEXT NOT NULL,
  FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE SET NULL
);
CREATE INDEX idx_email_events_booking ON email_events(booking_id);
