-- ===========================================================================
-- Seed data for Release 1.
-- Illustrative prices only (not agreed venue prices). Prices in pence.
-- ===========================================================================

-- Pricing categories
INSERT INTO pricing_categories (id, name, label, sort_order) VALUES
  ('cat_scouts',    'scouts',    'Scouts', 1),
  ('cat_community', 'community', 'Other Community Organisations (incl. Girlguiding)', 2),
  ('cat_public',    'public',    'General Public', 3);

-- Roles
INSERT INTO roles (id, name, description) VALUES
  ('role_super_admin', 'super_admin', 'Full administrative access incl. managing administrators'),
  ('role_admin',       'admin',       'Operational administrative access');

-- Resources (six initial resources)
INSERT INTO resources (id, name, slug, description, resource_type, is_active, requires_approval, pricing_model, created_at, updated_at) VALUES
  ('res_whole',   'Whole Venue', 'whole-venue', 'The entire venue including all halls, kitchen, field and camping.', 'combined',   1, 1, 'fixed',   '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('res_small',   'Small Hall',  'small-hall',  'A cosy hall ideal for smaller groups and meetings.',               'individual', 1, 0, 'hourly',  '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('res_main',    'Main Hall',   'main-hall',   'Our largest indoor space, perfect for events and activities.',     'individual', 1, 0, 'hourly',  '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('res_kitchen', 'Kitchen',     'kitchen',     'Fully equipped kitchen facilities.',                               'individual', 1, 0, 'hourly',  '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('res_field',   'Event Field', 'event-field', 'Open outdoor field for events and activities.',                    'individual', 1, 1, 'nightly', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'),
  ('res_camping', 'Camping',     'camping',     'Camping pitches with access to facilities.',                       'individual', 1, 1, 'nightly', '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z');

-- Pricing (illustrative). amount in pence.
INSERT INTO resource_pricing (id, resource_id, category_id, amount_pence, is_free, updated_at) VALUES
  -- Main Hall hourly: £10 / £15 / £25
  ('pr_main_s', 'res_main', 'cat_scouts', 1000, 0, '2024-01-01T00:00:00Z'),
  ('pr_main_c', 'res_main', 'cat_community', 1500, 0, '2024-01-01T00:00:00Z'),
  ('pr_main_p', 'res_main', 'cat_public', 2500, 0, '2024-01-01T00:00:00Z'),
  -- Small Hall hourly: £5 / £10 / £15
  ('pr_small_s', 'res_small', 'cat_scouts', 500, 0, '2024-01-01T00:00:00Z'),
  ('pr_small_c', 'res_small', 'cat_community', 1000, 0, '2024-01-01T00:00:00Z'),
  ('pr_small_p', 'res_small', 'cat_public', 1500, 0, '2024-01-01T00:00:00Z'),
  -- Kitchen hourly
  ('pr_kitchen_s', 'res_kitchen', 'cat_scouts', 300, 0, '2024-01-01T00:00:00Z'),
  ('pr_kitchen_c', 'res_kitchen', 'cat_community', 500, 0, '2024-01-01T00:00:00Z'),
  ('pr_kitchen_p', 'res_kitchen', 'cat_public', 800, 0, '2024-01-01T00:00:00Z'),
  -- Event Field nightly
  ('pr_field_s', 'res_field', 'cat_scouts', 1500, 0, '2024-01-01T00:00:00Z'),
  ('pr_field_c', 'res_field', 'cat_community', 2500, 0, '2024-01-01T00:00:00Z'),
  ('pr_field_p', 'res_field', 'cat_public', 3500, 0, '2024-01-01T00:00:00Z'),
  -- Camping per night: £20 / £30 / £40
  ('pr_camping_s', 'res_camping', 'cat_scouts', 2000, 0, '2024-01-01T00:00:00Z'),
  ('pr_camping_c', 'res_camping', 'cat_community', 3000, 0, '2024-01-01T00:00:00Z'),
  ('pr_camping_p', 'res_camping', 'cat_public', 4000, 0, '2024-01-01T00:00:00Z'),
  -- Whole Venue fixed: £50 / £75 / £100
  ('pr_whole_s', 'res_whole', 'cat_scouts', 5000, 0, '2024-01-01T00:00:00Z'),
  ('pr_whole_c', 'res_whole', 'cat_community', 7500, 0, '2024-01-01T00:00:00Z'),
  ('pr_whole_p', 'res_whole', 'cat_public', 10000, 0, '2024-01-01T00:00:00Z');

-- Mandatory self-conflicts (a resource always conflicts with itself).
INSERT INTO resource_conflicts (id, resource_id, conflicts_with_id, is_mandatory, created_at) VALUES
  ('rc_self_whole',   'res_whole',   'res_whole',   1, '2024-01-01T00:00:00Z'),
  ('rc_self_small',   'res_small',   'res_small',   1, '2024-01-01T00:00:00Z'),
  ('rc_self_main',    'res_main',    'res_main',    1, '2024-01-01T00:00:00Z'),
  ('rc_self_kitchen', 'res_kitchen', 'res_kitchen', 1, '2024-01-01T00:00:00Z'),
  ('rc_self_field',   'res_field',   'res_field',   1, '2024-01-01T00:00:00Z'),
  ('rc_self_camping', 'res_camping', 'res_camping', 1, '2024-01-01T00:00:00Z');

-- Mandatory Whole Venue relationships (bidirectional): Whole Venue conflicts
-- with every individual resource and vice-versa.
INSERT INTO resource_conflicts (id, resource_id, conflicts_with_id, is_mandatory, created_at) VALUES
  ('rc_wv_small_a',   'res_whole', 'res_small',   1, '2024-01-01T00:00:00Z'),
  ('rc_wv_small_b',   'res_small', 'res_whole',   1, '2024-01-01T00:00:00Z'),
  ('rc_wv_main_a',    'res_whole', 'res_main',    1, '2024-01-01T00:00:00Z'),
  ('rc_wv_main_b',    'res_main',  'res_whole',   1, '2024-01-01T00:00:00Z'),
  ('rc_wv_kitchen_a', 'res_whole', 'res_kitchen', 1, '2024-01-01T00:00:00Z'),
  ('rc_wv_kitchen_b', 'res_kitchen','res_whole',  1, '2024-01-01T00:00:00Z'),
  ('rc_wv_field_a',   'res_whole', 'res_field',   1, '2024-01-01T00:00:00Z'),
  ('rc_wv_field_b',   'res_field', 'res_whole',   1, '2024-01-01T00:00:00Z'),
  ('rc_wv_camping_a', 'res_whole', 'res_camping', 1, '2024-01-01T00:00:00Z'),
  ('rc_wv_camping_b', 'res_camping','res_whole',  1, '2024-01-01T00:00:00Z');
