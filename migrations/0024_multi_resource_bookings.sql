-- ===========================================================================
-- One booking for several resources.
--
-- Booking several resources for the same time used to create one booking per
-- resource. Now it is one booking, with one reference, status and total; the
-- resources it holds are its booking_resources rows, each with its own price
-- (what that resource charges). bookings.resource_id stays as the booking's
-- first resource, and bookings.total_amount_pence and the other price columns
-- hold the whole booking's figures.
--
-- Change requests can now change which resources a booking holds, so they
-- keep the full list before and after (JSON arrays of resource ids), and an
-- invoice keeps one line per resource.
--
-- Adds columns and backfills them, so it is safe to apply before the code
-- deploys. Existing single-resource bookings keep working unchanged.
-- ===========================================================================

ALTER TABLE booking_resources ADD COLUMN total_amount_pence INTEGER;
ALTER TABLE booking_resources ADD COLUMN base_amount_pence INTEGER;
ALTER TABLE booking_resources ADD COLUMN discount_pence INTEGER;
ALTER TABLE booking_resources ADD COLUMN discount_label TEXT;
ALTER TABLE booking_resources ADD COLUMN price_breakdown TEXT;

-- Every booking holds at least its own resource.
INSERT OR IGNORE INTO booking_resources (booking_id, resource_id) SELECT id, resource_id FROM bookings;

UPDATE booking_resources SET
  total_amount_pence = (SELECT b.total_amount_pence FROM bookings b WHERE b.id = booking_resources.booking_id),
  base_amount_pence  = (SELECT COALESCE(b.base_amount_pence, b.total_amount_pence) FROM bookings b WHERE b.id = booking_resources.booking_id),
  discount_pence     = (SELECT COALESCE(b.discount_pence, 0) FROM bookings b WHERE b.id = booking_resources.booking_id),
  discount_label     = (SELECT b.discount_label FROM bookings b WHERE b.id = booking_resources.booking_id),
  price_breakdown    = (SELECT b.price_breakdown FROM bookings b WHERE b.id = booking_resources.booking_id)
WHERE total_amount_pence IS NULL;

ALTER TABLE booking_amendments ADD COLUMN from_resource_ids TEXT;
ALTER TABLE booking_amendments ADD COLUMN to_resource_ids TEXT;
UPDATE booking_amendments SET from_resource_ids = json_array(from_resource_id), to_resource_ids = json_array(to_resource_id);

ALTER TABLE invoices ADD COLUMN lines TEXT;

-- Every booking holds at least its main resource, however it is written: the
-- booking code then replaces this row with the resource's price.
CREATE TRIGGER bookings_hold_main_resource AFTER INSERT ON bookings
BEGIN
  INSERT OR IGNORE INTO booking_resources (booking_id, resource_id, total_amount_pence, base_amount_pence, discount_pence, discount_label, price_breakdown)
  VALUES (NEW.id, NEW.resource_id, NEW.total_amount_pence, COALESCE(NEW.base_amount_pence, NEW.total_amount_pence), COALESCE(NEW.discount_pence, 0),
          NEW.discount_label, NEW.price_breakdown);
END;
