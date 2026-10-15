-- ===========================================================================
-- Release 2 / FR01: organisations, memberships and invitations.
-- Organisation roles are separate from platform administration roles and
-- never grant platform permissions. Existing bookings are untouched: the new
-- booking columns are nullable, so Release 1 bookings stay personal bookings.
-- ===========================================================================

CREATE TABLE organisation_types (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

INSERT INTO organisation_types (id, label, sort_order) VALUES
  ('scout_group',     'Scout Group', 1),
  ('explorer_unit',   'Explorer Scout Unit', 2),
  ('girlguiding',     'Girlguiding unit', 3),
  ('community',       'Community organisation', 4),
  ('club',            'Club or association', 5),
  ('other',           'Other organisation', 6);

CREATE TABLE organisations (
  id                      TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,             -- not required to be unique
  organisation_type_id    TEXT NOT NULL,
  pricing_category_id     TEXT NOT NULL,
  contact_email           TEXT NOT NULL,
  contact_phone_encrypted TEXT,                      -- encrypted at rest
  created_by              TEXT NOT NULL,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  FOREIGN KEY (organisation_type_id) REFERENCES organisation_types(id),
  FOREIGN KEY (pricing_category_id) REFERENCES pricing_categories(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);
CREATE INDEX idx_organisations_name ON organisations(name);

CREATE TABLE organisation_memberships (
  organisation_id TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('manager', 'member')),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (organisation_id, user_id),
  FOREIGN KEY (organisation_id) REFERENCES organisations(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_org_memberships_user ON organisation_memberships(user_id);

CREATE TABLE organisation_invitations (
  id              TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL,
  email           TEXT NOT NULL,                     -- lower-cased
  role            TEXT NOT NULL CHECK (role IN ('manager', 'member')),
  token_hash      TEXT NOT NULL UNIQUE,              -- only the hash is stored
  -- pending | accepted | declined | revoked | expired
  status          TEXT NOT NULL,
  invited_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  responded_at    TEXT,
  responded_by    TEXT,
  FOREIGN KEY (organisation_id) REFERENCES organisations(id) ON DELETE CASCADE
);
-- At most one active invitation per organisation and email address.
CREATE UNIQUE INDEX idx_org_invitations_active ON organisation_invitations(organisation_id, email) WHERE status = 'pending';
CREATE INDEX idx_org_invitations_org ON organisation_invitations(organisation_id);

-- Bookings may be made on behalf of an organisation. user_id stays the
-- customer of record (the person who booked); created_by is whoever submitted
-- it (the customer, or an administrator booking for them).
ALTER TABLE bookings ADD COLUMN organisation_id TEXT REFERENCES organisations(id);
ALTER TABLE bookings ADD COLUMN created_by TEXT;
CREATE INDEX idx_bookings_organisation ON bookings(organisation_id);

INSERT INTO app_settings (key, value, updated_at) VALUES
  ('invitation_expiry_days', '7', '2026-10-15T00:00:00.000Z');
