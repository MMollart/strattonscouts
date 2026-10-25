-- ===========================================================================
-- Invoices: an administrator sends the hirer an invoice for a booking.
--
-- Each invoice has its own sequential number (INV-000001, ...) and keeps a
-- snapshot of what it charged, so it still reads the same after the booking
-- is amended. Sending again while the price is unchanged resends the same
-- invoice; a changed price issues a new one. Payment itself stays out of
-- scope. Adds a table only, so this is safe to apply before the code deploys.
-- ===========================================================================

CREATE TABLE invoices (
  id                 TEXT PRIMARY KEY,
  sequence           INTEGER NOT NULL UNIQUE,
  invoice_number     TEXT NOT NULL UNIQUE,
  booking_id         TEXT NOT NULL REFERENCES bookings(id),
  amount_pence       INTEGER NOT NULL,
  base_amount_pence  INTEGER NOT NULL,
  discount_pence     INTEGER NOT NULL DEFAULT 0,
  discount_label     TEXT,
  issued_at          TEXT NOT NULL,
  due_date           TEXT NOT NULL,                  -- UK date, YYYY-MM-DD
  issued_by          TEXT REFERENCES users(id),
  last_sent_at       TEXT NOT NULL,
  send_count         INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_invoices_booking ON invoices(booking_id, sequence);
