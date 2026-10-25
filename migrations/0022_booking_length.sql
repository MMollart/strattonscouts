-- Booking length rules (customer feedback): a resource can set how long a
-- booking must or may be, in hours (hall-style resources) or nights (nightly
-- resources such as Camping, where a minimum of 1 night means the booking
-- must end on a later day than it starts), and the usual arrival and
-- departure times the booking form starts with. NULL means no rule.
ALTER TABLE resources ADD COLUMN min_duration_minutes INTEGER;
ALTER TABLE resources ADD COLUMN max_duration_minutes INTEGER;
ALTER TABLE resources ADD COLUMN min_nights INTEGER;
ALTER TABLE resources ADD COLUMN max_nights INTEGER;
ALTER TABLE resources ADD COLUMN default_start_time TEXT;
ALTER TABLE resources ADD COLUMN default_end_time TEXT;
