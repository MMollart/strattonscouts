-- ===========================================================================
-- Release 2 / FR14: organisation-specific pricing arrangements.
--   rate            agreed price for one resource (own charging model)
--   free            free use of one resource
--   percentage      discount on the standard category rate (basis points)
--   fixed_discount  discount on the standard category rate (pence)
-- resource_id NULL (discounts only) applies to every resource.
-- ===========================================================================

CREATE TABLE organisation_pricing (
  id               TEXT PRIMARY KEY,
  organisation_id  TEXT NOT NULL,
  resource_id      TEXT,
  arrangement_type TEXT NOT NULL CHECK (arrangement_type IN ('rate', 'free', 'percentage', 'fixed_discount')),
  pricing_model    TEXT CHECK (pricing_model IN ('hourly', 'nightly', 'fixed')),
  value            INTEGER NOT NULL DEFAULT 0 CHECK (value >= 0),
  effective_from   TEXT NOT NULL,
  effective_to     TEXT,
  is_active        INTEGER NOT NULL DEFAULT 1,
  notes            TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  updated_by       TEXT,
  FOREIGN KEY (organisation_id) REFERENCES organisations(id) ON DELETE CASCADE,
  FOREIGN KEY (resource_id) REFERENCES resources(id) ON DELETE CASCADE
);
CREATE INDEX idx_org_pricing_lookup ON organisation_pricing(organisation_id, resource_id);

ALTER TABLE bookings ADD COLUMN organisation_pricing_id TEXT;
