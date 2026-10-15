-- ===========================================================================
-- Release 2 / FR02: advanced pricing engine.
-- pricing_rates supersedes resource_pricing: rates now carry their own pricing
-- model (hourly | nightly | fixed | free) and effective dates. Existing prices
-- are copied across as open-ended rates effective from the beginning of time,
-- so quotes are unchanged. resource_pricing is kept (not dropped) for
-- rollback but is no longer read.
-- Bookings gain a fuller price snapshot. Existing bookings are backfilled from
-- their Release 1 snapshot, so their agreed price is preserved exactly.
-- ===========================================================================

CREATE TABLE pricing_rates (
  id             TEXT PRIMARY KEY,
  resource_id    TEXT NOT NULL,
  category_id    TEXT NOT NULL,
  pricing_model  TEXT NOT NULL CHECK (pricing_model IN ('hourly', 'nightly', 'fixed', 'free')),
  amount_pence   INTEGER NOT NULL DEFAULT 0 CHECK (amount_pence >= 0),
  effective_from TEXT NOT NULL,          -- inclusive, compared with the booking start
  effective_to   TEXT,                   -- exclusive, NULL = open-ended
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  updated_by     TEXT,
  FOREIGN KEY (resource_id) REFERENCES resources(id) ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES pricing_categories(id) ON DELETE CASCADE
);
CREATE INDEX idx_pricing_rates_lookup ON pricing_rates(resource_id, category_id, effective_from);

INSERT INTO pricing_rates (id, resource_id, category_id, pricing_model, amount_pence, effective_from, effective_to, is_active, created_at, updated_at)
SELECT 'rate_' || rp.id,
       rp.resource_id,
       rp.category_id,
       CASE WHEN rp.is_free = 1 THEN 'free' ELSE r.pricing_model END,
       CASE WHEN rp.is_free = 1 THEN 0 ELSE rp.amount_pence END,
       '1970-01-01T00:00:00.000Z',
       NULL,
       1,
       rp.updated_at,
       rp.updated_at
FROM resource_pricing rp JOIN resources r ON r.id = rp.resource_id;

-- General discounts. value is basis points for percentage discounts
-- (2000 = 20%) and pence for fixed discounts. NULL resource/category = all.
CREATE TABLE pricing_discounts (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  discount_type  TEXT NOT NULL CHECK (discount_type IN ('percentage', 'fixed')),
  value          INTEGER NOT NULL CHECK (value >= 0),
  resource_id    TEXT,
  category_id    TEXT,
  effective_from TEXT NOT NULL,
  effective_to   TEXT,
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  updated_by     TEXT,
  FOREIGN KEY (resource_id) REFERENCES resources(id) ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES pricing_categories(id) ON DELETE CASCADE
);

-- Categories can be added and retired by administrators.
ALTER TABLE pricing_categories ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;

-- Fuller agreed-price snapshot on bookings.
ALTER TABLE bookings ADD COLUMN base_amount_pence INTEGER;
ALTER TABLE bookings ADD COLUMN discount_pence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN discount_label TEXT;
ALTER TABLE bookings ADD COLUMN pricing_rate_id TEXT;
ALTER TABLE bookings ADD COLUMN pricing_discount_id TEXT;
ALTER TABLE bookings ADD COLUMN price_breakdown TEXT;   -- JSON, informational

UPDATE bookings SET base_amount_pence = total_amount_pence WHERE base_amount_pence IS NULL;
