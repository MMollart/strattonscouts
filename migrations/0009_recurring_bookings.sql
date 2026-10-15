-- Release 2 / FR05: recurring bookings.
-- A series records the pattern a customer asked for. Each occurrence is an
-- ordinary booking linked by series_id, so availability, pricing, approval,
-- cancellation and history work exactly as for single bookings.

CREATE TABLE recurrence_series (
  id               TEXT PRIMARY KEY,
  reference        TEXT NOT NULL UNIQUE,
  user_id          TEXT NOT NULL REFERENCES users(id),
  organisation_id  TEXT REFERENCES organisations(id),
  resource_id      TEXT NOT NULL REFERENCES resources(id),
  frequency        TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly', 'fortnightly', 'monthly')),
  monthly_mode     TEXT CHECK (monthly_mode IN ('day_of_month', 'nth_weekday')),
  start_date       TEXT NOT NULL,
  start_time       TEXT NOT NULL,
  end_time         TEXT NOT NULL,
  until_date       TEXT,
  occurrence_count INTEGER,
  excluded_dates   TEXT NOT NULL DEFAULT '[]',
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  created_by       TEXT NOT NULL REFERENCES users(id),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX idx_series_user ON recurrence_series(user_id);
CREATE INDEX idx_series_org ON recurrence_series(organisation_id);

ALTER TABLE bookings ADD COLUMN series_id TEXT REFERENCES recurrence_series(id);
CREATE INDEX idx_bookings_series ON bookings(series_id, starts_at);
