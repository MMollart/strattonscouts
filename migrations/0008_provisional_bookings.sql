-- Release 2 / FR04: provisional bookings and automatic expiry.
-- A provisional booking holds its resource until expires_at. It stops blocking
-- availability as soon as expires_at passes, and the scheduled Worker
-- (workers/scheduler) then marks it expired and emails the customer.

ALTER TABLE bookings ADD COLUMN expires_at TEXT;
ALTER TABLE resources ADD COLUMN provisional_expiry_hours INTEGER;

CREATE INDEX idx_bookings_provisional_expiry ON bookings(expires_at) WHERE status = 'provisional';

INSERT OR IGNORE INTO app_settings (key, value, updated_at, updated_by)
VALUES ('provisional_expiry_hours', '48', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL);
