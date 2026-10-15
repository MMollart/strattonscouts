-- Release 2 / FR07: physical asset management (keys, fobs, cards, equipment).
-- An asset's status says whether it can be lent; assignments are the history.
-- A partial unique index guarantees at most one open assignment per asset.

CREATE TABLE asset_types (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL COLLATE NOCASE UNIQUE,
  description TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

CREATE TABLE assets (
  id            TEXT PRIMARY KEY,
  asset_type_id TEXT NOT NULL REFERENCES asset_types(id),
  name          TEXT NOT NULL,
  description   TEXT,
  reference     TEXT COLLATE NOCASE,
  status        TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'assigned', 'lost', 'damaged', 'retired')),
  created_by    TEXT REFERENCES users(id),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
-- Serial or reference numbers are optional but unique when given.
CREATE UNIQUE INDEX idx_assets_reference ON assets(reference) WHERE reference IS NOT NULL;
CREATE INDEX idx_assets_status ON assets(status);

CREATE TABLE asset_assignments (
  id            TEXT PRIMARY KEY,
  asset_id      TEXT NOT NULL REFERENCES assets(id),
  user_id       TEXT NOT NULL REFERENCES users(id),
  assigned_by   TEXT NOT NULL REFERENCES users(id),
  assigned_at   TEXT NOT NULL,
  assign_notes  TEXT,
  returned_at   TEXT,
  returned_by   TEXT REFERENCES users(id),
  return_notes  TEXT,
  -- How the assignment ended: returned in good order, returned damaged, or reported lost.
  outcome       TEXT CHECK (outcome IN ('available', 'damaged', 'lost')),
  CHECK ((returned_at IS NULL) = (outcome IS NULL) AND (returned_at IS NULL) = (returned_by IS NULL))
);
CREATE UNIQUE INDEX idx_asset_assignments_open ON asset_assignments(asset_id) WHERE returned_at IS NULL;
CREATE INDEX idx_asset_assignments_user ON asset_assignments(user_id, returned_at);
CREATE INDEX idx_asset_assignments_asset ON asset_assignments(asset_id, assigned_at);

INSERT INTO asset_types (id, name, description, sort_order, is_active, created_at) VALUES
  ('atype_fob',  'Key fob',          'Electronic door fob',              1, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('atype_key',  'Physical key',     'Door, cupboard or gate key',       2, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('atype_card', 'Access card',      NULL,                               3, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('atype_equip','Loaned equipment', 'Equipment lent to a hirer',        4, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
