-- Release 2 / FR12: customer booking amendments.
-- A request records the proposed date, times and resource with the price the
-- customer agreed to. The original booking stays active until an
-- administrator approves the request, when the booking is updated atomically.

CREATE TABLE booking_amendments (
  id                TEXT PRIMARY KEY,
  booking_id        TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  requested_by      TEXT NOT NULL REFERENCES users(id),
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  from_resource_id  TEXT NOT NULL,
  from_starts_at    TEXT NOT NULL,
  from_ends_at      TEXT NOT NULL,
  from_total_pence  INTEGER NOT NULL,
  to_resource_id    TEXT NOT NULL REFERENCES resources(id),
  to_starts_at      TEXT NOT NULL,
  to_ends_at        TEXT NOT NULL,
  to_total_pence    INTEGER NOT NULL,
  price_breakdown   TEXT NOT NULL,
  customer_note     TEXT,
  decided_by        TEXT REFERENCES users(id),
  decided_at        TEXT,
  decision_note     TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- At most one open request per booking.
CREATE UNIQUE INDEX idx_amendments_one_pending ON booking_amendments(booking_id) WHERE status = 'pending';
CREATE INDEX idx_amendments_status ON booking_amendments(status, created_at);
