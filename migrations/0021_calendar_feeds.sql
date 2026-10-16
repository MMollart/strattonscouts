-- ===========================================================================
-- Release 3 / FR17: external calendar integration.
--
-- Subscription feeds are read-only iCalendar URLs. Each URL carries a random
-- token that works like a password, so only its SHA-256 hash is stored; the
-- URL is shown once when the feed is created or regenerated. Revoking a feed
-- keeps the row (for the audit history) but stops the URL working.
--
-- kind:
--   user          the owner's own bookings
--   organisation  an organisation's bookings (created by its managers)
--   admin         venue bookings, for all or chosen resources
--
-- Safe to apply before the code is deployed: new table and permission only.
-- ===========================================================================

CREATE TABLE calendar_feeds (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('user', 'organisation', 'admin')),
  name            TEXT NOT NULL,
  owner_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organisation_id TEXT REFERENCES organisations(id) ON DELETE CASCADE,
  -- admin feeds: JSON array of resource ids (each includes the resources
  -- that are part of it); NULL means every resource
  resource_ids    TEXT,
  -- admin feeds: show the organisation or customer name on each event
  show_names      INTEGER NOT NULL DEFAULT 0,
  token_hash      TEXT NOT NULL UNIQUE,
  token_hint      TEXT NOT NULL,          -- last 4 characters, to tell URLs apart
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  regenerated_at  TEXT,
  last_used_at    TEXT,
  revoked_at      TEXT,
  revoked_by      TEXT,
  CHECK ((kind = 'organisation') = (organisation_id IS NOT NULL))
);
CREATE INDEX idx_calendar_feeds_owner ON calendar_feeds(owner_id);
CREATE INDEX idx_calendar_feeds_org ON calendar_feeds(organisation_id);

INSERT INTO permissions (key, description) VALUES
  ('calendar.manage', 'Create venue calendar subscriptions and manage everyone''s calendar feeds');

INSERT INTO role_permissions (role_id, permission_key) VALUES
  ('role_super_admin', 'calendar.manage'),
  ('role_admin',       'calendar.manage');

