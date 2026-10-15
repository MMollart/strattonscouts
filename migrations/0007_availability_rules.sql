-- ===========================================================================
-- Release 2 / FR03: advanced availability rules.
-- Rules are checked when a booking is requested (and re-checked for
-- amendments); they never alter existing bookings. Exceptional closures stay
-- in resource_closures (Release 1).
-- ===========================================================================

-- Per-resource booking window. NULL = no restriction.
ALTER TABLE resources ADD COLUMN min_notice_minutes INTEGER;
ALTER TABLE resources ADD COLUMN max_advance_days INTEGER;

-- Recurring weekly availability, in UK local time.
--   closed: the resource cannot be booked in this window (e.g. every Tuesday 18:00-21:00)
--   open:   normal opening hours. When a resource has open rules, bookings
--           must fall entirely within them.
-- days_of_week: comma-separated, Monday = 0 ... Sunday = 6.
-- end_time <= start_time means the window runs past midnight (00:00-00:00 = all day).
-- valid_from / valid_to (YYYY-MM-DD, inclusive) limit a rule to a season.
CREATE TABLE availability_rules (
  id           TEXT PRIMARY KEY,
  resource_id  TEXT NOT NULL,
  rule_type    TEXT NOT NULL CHECK (rule_type IN ('closed', 'open')),
  days_of_week TEXT NOT NULL,
  start_time   TEXT NOT NULL,
  end_time     TEXT NOT NULL,
  valid_from   TEXT,
  valid_to     TEXT,
  label        TEXT,
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  updated_by   TEXT,
  FOREIGN KEY (resource_id) REFERENCES resources(id) ON DELETE CASCADE
);
CREATE INDEX idx_availability_rules_resource ON availability_rules(resource_id);

-- Every administrative override of a restriction, per booking.
CREATE TABLE availability_overrides (
  id          TEXT PRIMARY KEY,
  booking_id  TEXT NOT NULL,
  rule        TEXT NOT NULL,          -- min_notice | max_advance | opening_hours | recurring_restriction
  detail      TEXT,                   -- what the rule said, e.g. "Requires 24 hours' notice"
  admin_id    TEXT NOT NULL,
  reason      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE
);
CREATE INDEX idx_availability_overrides_booking ON availability_overrides(booking_id);
