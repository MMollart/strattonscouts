-- ===========================================================================
-- Release 3 / FR10: financial reporting.
--
-- Reports are worked out from the price snapshot stored on each booking
-- (total_amount_pence, base_amount_pence, discount_pence), so no new tables
-- are needed. This adds the export permission and an index for reports by
-- booking date. Safe to apply before the code is deployed.
-- ===========================================================================

CREATE INDEX IF NOT EXISTS idx_bookings_created ON bookings(created_at);
CREATE INDEX IF NOT EXISTS idx_bookings_time ON bookings(starts_at, ends_at);

INSERT INTO permissions (key, description) VALUES
  ('finance.export', 'Export financial reports to CSV');

INSERT INTO role_permissions (role_id, permission_key) VALUES
  ('role_super_admin', 'finance.export'),
  ('role_admin',       'finance.export');
