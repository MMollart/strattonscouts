-- Several resources booked together for the same time (for example the Main
-- Hall and the Kitchen). Each resource keeps its own booking row, reference,
-- price and approval; group_id ties them together. Created atomically: all
-- of a group's bookings are written, or none.
ALTER TABLE bookings ADD COLUMN group_id TEXT;
CREATE INDEX idx_bookings_group ON bookings(group_id) WHERE group_id IS NOT NULL;
