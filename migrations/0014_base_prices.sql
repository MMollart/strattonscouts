-- One base price per resource, adjusted automatically for each price group.
--
-- base_rates replaces the per-category pricing_rates: each resource has a
-- dated base price (hourly | nightly | fixed | free), and each price group
-- (pricing_categories) has a percentage adjustment in basis points
-- (-2500 = 25% less, 5000 = 50% more, -10000 = free). A group's price is
-- base * (1 + adjustment), rounded to the nearest penny.
--
-- Existing prices are migrated as follows:
--   * The base price of each resource is its rate for the first price group
--     (lowest sort order, e.g. Scouts) that has one, so that group's prices
--     are unchanged. Dated and future rates are copied with their dates.
--   * Each other group's adjustment is the average, across resources, of its
--     current rate divided by the base rate, rounded to a whole percent.
--     Where a group's old prices were not in the same proportion for every
--     resource, its prices change slightly; review them under Admin > Pricing.
-- pricing_rates is kept (no longer read) for reference and rollback. Existing
-- bookings keep the price agreed when they were made.

ALTER TABLE pricing_categories ADD COLUMN price_adjustment_bp INTEGER NOT NULL DEFAULT 0 CHECK (price_adjustment_bp >= -10000);

CREATE TABLE base_rates (
  id             TEXT PRIMARY KEY,
  resource_id    TEXT NOT NULL,
  pricing_model  TEXT NOT NULL CHECK (pricing_model IN ('hourly', 'nightly', 'fixed', 'free')),
  amount_pence   INTEGER NOT NULL DEFAULT 0 CHECK (amount_pence >= 0),
  effective_from TEXT NOT NULL,
  effective_to   TEXT,
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  updated_by     TEXT,
  FOREIGN KEY (resource_id) REFERENCES resources(id) ON DELETE CASCADE
);
CREATE INDEX idx_base_rates_lookup ON base_rates(resource_id, effective_from);

-- Base prices: every rate of the first price group that prices each resource.
INSERT INTO base_rates (id, resource_id, pricing_model, amount_pence, effective_from, effective_to, is_active, created_at, updated_at, updated_by)
SELECT pr.id, pr.resource_id, pr.pricing_model, pr.amount_pence, pr.effective_from, pr.effective_to, pr.is_active, pr.created_at, pr.updated_at, pr.updated_by
FROM pricing_rates pr
WHERE pr.category_id = (
  SELECT pc.id FROM pricing_rates x JOIN pricing_categories pc ON pc.id = x.category_id
  WHERE x.resource_id = pr.resource_id AND x.is_active = 1
  ORDER BY pc.sort_order, pc.id LIMIT 1
);

-- Adjustments from the rates in force now.
UPDATE pricing_categories SET price_adjustment_bp = COALESCE((
  SELECT CAST(ROUND(AVG(cur.amount_pence * 100.0 / base.amount_pence)) AS INTEGER) * 100 - 10000
  FROM pricing_rates cur
  JOIN base_rates base ON base.resource_id = cur.resource_id
  WHERE cur.category_id = pricing_categories.id
    AND cur.is_active = 1 AND base.is_active = 1
    AND cur.pricing_model = base.pricing_model AND base.amount_pence > 0
    AND cur.effective_from <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AND (cur.effective_to IS NULL OR cur.effective_to > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    AND base.effective_from <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AND (base.effective_to IS NULL OR base.effective_to > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
), 0);
