-- Resource hierarchy replaces the conflict matrix and the 'combined' type.
-- Safe to apply before deploying the code that uses it.
--
-- Each resource may be part of a parent (Main Hall is part of Indoor, which is
-- part of the Whole Venue). Booking or closing a resource blocks everything
-- above and below it; siblings stay independent.
--
-- Backfill from the conflict matrix:
--   1. A resource's parent is the nearest resource it conflicts with that
--      conflicts with more resources than it does (Main Hall -> Building,
--      because Building also conflicts with Small Hall and Kitchen).
--   2. Otherwise, the combined resource (Whole Venue) if there is exactly one.
-- Checked against production on 2026-10-15: every conflict there fits this
-- (Whole Venue > Building > Main Hall, Small Hall, Kitchen; everything else
-- directly under Whole Venue).

ALTER TABLE resources ADD COLUMN parent_id TEXT REFERENCES resources(id) ON DELETE SET NULL;

CREATE TABLE _conflict_partners AS
  SELECT resource_id AS a, conflicts_with_id AS b FROM resource_conflicts WHERE resource_id <> conflicts_with_id
  UNION
  SELECT conflicts_with_id, resource_id FROM resource_conflicts WHERE resource_id <> conflicts_with_id;

CREATE TABLE _conflict_counts AS
  SELECT a AS id, COUNT(*) AS n FROM _conflict_partners GROUP BY a;

UPDATE resources SET parent_id = COALESCE(
  (SELECT p.b FROM _conflict_partners p
     JOIN resources y ON y.id = p.b AND y.resource_type <> 'combined'
     JOIN _conflict_counts cy ON cy.id = p.b
     JOIN _conflict_counts cx ON cx.id = resources.id
   WHERE p.a = resources.id AND cy.n > cx.n
   ORDER BY cy.n, y.created_at LIMIT 1),
  (SELECT c.id FROM resources c
   WHERE c.resource_type = 'combined' AND c.id <> resources.id
     AND (SELECT COUNT(*) FROM resources WHERE resource_type = 'combined') = 1)
)
WHERE resource_type <> 'combined';

DROP TABLE _conflict_counts;
DROP TABLE _conflict_partners;

CREATE INDEX idx_resources_parent ON resources(parent_id);

-- resource_conflicts and resources.resource_type are no longer read, but are
-- left in place so this migration can run before the new code is deployed
-- without breaking the code that is live. A later migration drops them.
