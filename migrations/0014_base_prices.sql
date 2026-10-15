-- One full price per resource, with a percentage discount for each price group.
--
-- base_rates replaces the per-category pricing_rates: each resource has a
-- dated full price (hourly | nightly | fixed | free), which the general public
-- pays, and each price group (pricing_categories) has a discount off it in
-- basis points (2500 = 25% off, 10000 = free). A group's price is
-- full price * (1 - discount), rounded to the nearest penny.
--
-- Existing prices are migrated as follows:
--   * The full price of each resource is its rate for the last price group
--     (highest sort order, i.e. General Public) that has one, so public prices
--     are unchanged. Dated and future rates are copied with their dates.
--   * Each other group's discount is 100% less the average, across resources,
--     of its current rate divided by the full price, rounded to a whole
--     percent. Where a group's old prices were not in the same proportion for
--     every resource, its prices change slightly; review them under
--     Admin > Pricing.
-- pricing_rates is kept (no longer read) for reference and rollback. Existing
-- bookings keep the price agreed when they were made.

ALTER TABLE pricing_categories ADD COLUMN discount_bp INTEGER NOT NULL DEFAULT 0 CHECK (discount_bp BETWEEN 0 AND 10000);

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

-- Full prices: every rate of the last price group that prices each resource.
INSERT INTO base_rates (id, resource_id, pricing_model, amount_pence, effective_from, effective_to, is_active, created_at, updated_at, updated_by)
SELECT pr.id, pr.resource_id, pr.pricing_model, pr.amount_pence, pr.effective_from, pr.effective_to, pr.is_active, pr.created_at, pr.updated_at, pr.updated_by
FROM pricing_rates pr
WHERE pr.category_id = (
  SELECT pc.id FROM pricing_rates x JOIN pricing_categories pc ON pc.id = x.category_id
  WHERE x.resource_id = pr.resource_id AND x.is_active = 1
  ORDER BY pc.sort_order DESC, pc.id DESC LIMIT 1
);

-- Discounts from the rates in force now.
UPDATE pricing_categories SET discount_bp = COALESCE((
  SELECT MIN(10000, MAX(0, 10000 - CAST(ROUND(AVG(cur.amount_pence * 100.0 / base.amount_pence)) AS INTEGER) * 100))
  FROM pricing_rates cur
  JOIN base_rates base ON base.resource_id = cur.resource_id
  WHERE cur.category_id = pricing_categories.id
    AND cur.is_active = 1 AND base.is_active = 1
    AND cur.pricing_model = base.pricing_model AND base.amount_pence > 0
    AND cur.effective_from <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AND (cur.effective_to IS NULL OR cur.effective_to > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    AND base.effective_from <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AND (base.effective_to IS NULL OR base.effective_to > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
), 0);
