# Release 2 – Organisations, Operations & Booking Automation

This document records what Release 2 adds, how each feature is built on top of
the Release 1 code, and the implementation decisions taken where the
specification left a detail open. Each feature has its own migration so they
can be applied incrementally (`npm run db:migrate:local` / `:remote`).

| Migration | Feature |
| --- | --- |
| `0003_admin_roles.sql` | FR08 Advanced admin roles & permissions |
| `0004_organisations.sql` | FR01 Organisations, memberships & invitations |
| `0005_pricing_engine.sql` | FR02 Advanced pricing engine |
| `0006_organisation_pricing.sql` | FR14 Organisation-specific pricing |
| `0007_availability_rules.sql` | FR03 Advanced availability rules |
| `0008_provisional_bookings.sql` | FR04 Provisional bookings & automatic expiry |
| `0009_recurring_bookings.sql` | FR05 Recurring bookings |
| `0010_booking_amendments.sql` | FR12 Customer booking management & amendments |
| `0011_email_templates.sql` | FR06 Email templates & history |
| *(none)* | FR09 Admin calendar (reads existing tables) |
| `0012_assets.sql` | FR07 Physical asset management |
| `0013_booking_groups.sql` | Several resources in one booking |
| `0014_base_prices.sql` | One full (public) price per resource, with a discount per price group |

## FR08 – Advanced admin roles & permissions

**Roles.** Super Admin, Booking Admin and Viewer. The capability matrix from the
specification is stored as data: `permissions` lists twelve permission keys and
`role_permissions` maps roles to them. `getAuthUser` loads a user's roles *and*
permissions; every admin endpoint calls `requirePermission(env, request, key)`
(`functions/_lib/auth.ts`). The frontend receives the same list from `/api/me`
and uses `can(permission)` only to hide controls; the API is the authority.

| Permission | Super Admin | Booking Admin | Viewer |
| --- | :-: | :-: | :-: |
| `bookings.view` (bookings, customers, organisations) | ✓ | ✓ | ✓ |
| `bookings.create` | ✓ | ✓ | |
| `bookings.approve` | ✓ | ✓ | |
| `bookings.manage` (amend/cancel, correct a customer's category) | ✓ | ✓ | |
| `availability.manage` (closures, rules, overrides) | ✓ | ✓ | |
| `resources.manage` (resources, images, conflict matrix) | ✓ | ✓ | |
| `pricing.manage` | ✓ | | |
| `assets.manage` | ✓ | ✓ | |
| `email_templates.manage` | ✓ | | |
| `finance.view` | ✓ | ✓ | ✓ |
| `admins.manage` | ✓ | | |
| `settings.manage` | ✓ | | |

**Migration of Release 1 administrators.** The Release 1 `admin` role row is
renamed in place to `booking_admin` (its id `role_admin` is unchanged), so every
existing `user_roles` row keeps working with no data copy. Release 1 Super
Admins are unchanged. Release 1 admins could edit prices; as Booking Admins they
no longer can, which is what the matrix specifies. A Super Admin can promote
them if needed.

**Administrator management.** `/admin/admins` (API `GET /api/admin/admins`,
`PUT /api/admin/admins/:userId` with `{ role }`, `null` revokes). A user holds at
most one administration role. Each change is one D1 batch guarded by
`abortIf(...)` (`functions/_lib/txn.ts`), so the last Super Admin can never be
demoted or revoked, even by two simultaneous requests. Changes are recorded in
`admin_role_events`. Category correction stays on `/admin/users`.

**Application settings.** `app_settings` key/value table with defaults in
`src/shared/settings.ts`, edited by Super Admins at `/admin/settings`. Later
features add their settings there (invitation expiry, provisional expiry).

**Organisation permissions** (FR01) are separate tables and never grant any of
these permissions.

### Decisions

- *Where to keep the matrix:* (a) hard-coded in TypeScript, (b) role columns on
  `users`, (c) `permissions` + `role_permissions` tables. Chose (c): it matches
  the specification's entities, keeps one source of truth the API reads, and
  lets roles be adjusted with a migration rather than a deploy.
- *All-or-nothing writes:* (a) read-check-write in application code (racy), (b)
  `WHERE` clauses on each statement, (c) a guard statement that violates a
  `CHECK` constraint to roll back the batch. Chose (c) where several rows must
  change together; it relies on D1 running each batch as one transaction and is
  reused by recurring bookings and amendments.

## FR01 – Organisation management & invitations

**Data.** `organisations` (name, type, pricing category, contact email,
encrypted contact phone), `organisation_memberships` (`manager` | `member`) and
`organisation_invitations`. Bookings gain nullable `organisation_id` and
`created_by`; Release 1 bookings keep `organisation_id = NULL` and remain
personal bookings.

**Screens.** *Organisations* in the main navigation lists the user's
organisations and creates new ones (the creator becomes Organisation Manager).
The organisation page shows details, members, invitations and the
organisation's bookings. Admins see all organisations at `/admin/organisations`.

**Invitations.** A manager enters an email address; the server generates a
32-byte random token, stores only its SHA-256 hash, and emails
`/invitations/<token>`. The link page lets an existing user sign in or a new
user register and then accept or decline. Rules enforced server-side:

- the signed-in user's email must equal the invited address;
- tokens are single-use (status guard on the `UPDATE`, membership inserted in
  the same batch only if this request claimed it);
- expiry is configurable (`invitation_expiry_days`, default 7, in Settings);
- managers can revoke pending invitations;
- a partial unique index allows one pending invitation per organisation and
  address;
- invitations only create organisation memberships, never platform roles.

**Membership rules.** Managers invite, remove, promote and demote; members may
leave. Removing or demoting the last manager is refused by a guarded batch,
including under concurrent requests.

**Organisation bookings.** The booking form has a *Booking for* choice
(personal or one of the user's organisations). An organisation booking uses the
organisation's pricing category, stores `organisation_id`, keeps the booking
member as the customer (`user_id`) and records the submitter in `created_by`.
Every member can see the organisation's bookings (My Bookings and the
organisation page); the booking member and the organisation's managers can
cancel them.

### Decisions

- *Organisation roles storage:* (a) reuse `user_roles`, (b) a role column on
  `organisation_memberships`, (c) separate org role tables. Chose (b): it keeps
  organisation permissions completely separate from platform permissions with
  the least schema.
- *Duplicate active invitations:* (a) application check, (b) unique index on
  (org, email), (c) partial unique index on pending invitations. Chose (c):
  race-free, and old invitations stay as history. Stale pending invitations
  are marked `expired` before a new one is created.
- *Invitation link for someone who is not signed in:* the link page shows the
  organisation and a masked address; the full address is shown only to the
  signed-in recipient.

## FR02 – Advanced pricing engine

**Data.** `pricing_rates` replaces `resource_pricing` as the source of prices.
A rate is (resource, category, charging model, amount, effective from/to,
active). Charging models: per hour (rounded up), per night (UK calendar dates
crossed), fixed per booking, and free. The migration copies every Release 1
price into an open-ended rate, so every quote is unchanged; `resource_pricing`
is kept but no longer read. `pricing_discounts` holds fixed (pence) and
percentage (basis points, 2000 = 20%) discounts, optionally limited to one
resource and/or category, with effective dates. Categories gain `is_active`
and administrators can add new ones.

**Calculation** (`functions/_lib/pricing-engine.ts`, pure core
`computePrice` in `src/shared/pricing.ts`), always server-side:

1. resource and booking window;
2. duration in the rate's unit;
3. customer, or the organisation when booking on its behalf;
4. that party's pricing category;
5. the newest active rate for the resource and category whose period covers
   the booking start;
6. organisation arrangement (FR14), otherwise the single best eligible
   discount;
7. total in integer pence;
8. full breakdown returned.

`POST /api/pricing/quote` returns that breakdown and the booking form shows it
before submission; the booking endpoint calls the same function.

**History.** Each booking stores pricing category, model, unit price, base
amount, discount and its label, final amount, the rate and discount ids, and
the full breakdown JSON. Release 1 bookings are backfilled (base = total,
discount 0). Rate and discount changes never touch existing bookings.

**Screens.** Admin → Pricing has tabs for Rates, Discounts, Organisation
pricing (FR14), Categories and the Release 1 conflict matrix. Amounts are
entered in pounds and stored in pence.

### Decisions

- *Effective-dated rates:* (a) add columns to `resource_pricing` (its unique
  key allows only one price per resource and category), (b) rebuild that
  table, (c) a new `pricing_rates` table with the old rows copied in. Chose
  (c): non-destructive and allows several dated rates.
- *Which date a rate's period is compared with:* the booking start (the date
  of use), so a price list "from 1 April" applies to stays from 1 April.
- *Several matching discounts:* only the one giving the largest saving applies;
  discounts never stack, mirroring FR14's one-arrangement rule.

## FR14 – Organisation-specific pricing

**Data.** `organisation_pricing` arrangements per organisation: an agreed
*rate* for one resource (with its own charging model), *free* use of one
resource, or a *percentage* / *fixed* discount on the standard category rate
for one resource or all resources, each with effective dates, an active flag
and internal notes. Bookings record `organisation_pricing_id`.

**Precedence** (applied in `quoteFromContext` and `computePrice`):

1. organisation rate or free use for the resource;
2. organisation discount for the resource, then an all-resources organisation
   discount, applied to the standard category rate;
3. the standard category rate with the best general discount.

Only one organisation arrangement applies and it never stacks with general
discounts. The admin API refuses a second active arrangement for the same
organisation, resource scope and overlapping period (rates/free use and
discounts are checked separately, so "free Small Hall" can coexist with "20%
off everything").

**Screens.** Admin → Pricing → *Organisation pricing*: search organisations,
view, add, disable or remove arrangements and see their periods. Customers see
the result in their quote when booking on the organisation's behalf. Changes
never alter existing bookings.

## FR03 – Advanced availability rules

**Data.** Resources gain `min_notice_minutes` and `max_advance_days`.
`availability_rules` holds recurring rules per resource: *closed* ("Scout
meetings, Mon–Fri 18:00–21:00") or *open* (opening hours), days of the week,
UK wall-clock start/end times, an optional season (`valid_from`/`valid_to`), a
customer-facing label and an active flag. `availability_overrides` records
every rule an administrator overrode, with who, why and when.

**Evaluation** (`src/shared/availability-rules.ts`, pure and unit tested) runs
on every availability check and every booking create, server-side:

- times are UK local, so a 18:00 rule stays 18:00 across BST changes;
- an end time at or before the start runs past midnight (22:00–07:00);
- once a resource has any open rule, a booking must fall entirely within its
  opening windows (adjacent windows merge, so 09:00–13:00 plus 13:00–17:00
  allows 12:00–14:00);
- closed rules propagate exactly like Release 1 closures: one on the Whole
  Venue blocks every space, and one on a space blocks the Whole Venue. Opening
  hours stay on the resource they are set on.

The public availability endpoint returns `reason: "restricted"` with each
violated rule's message, which the booking form shows and uses to disable
submission. Resource pages list the rules.

**Overrides.** Admins with `availability.manage` creating a booking for a
customer see the restriction and can enter a reason to override it. The API
only overrides the restriction kinds named in the request, and records one
`availability_overrides` row per overridden rule in the same atomic batch as
the booking. Exceptional closures and clashing bookings can never be
overridden. Booking details show the override history to administrators.

**Decisions.**

- Rule edits never change existing bookings (same as closures in Release 1).
- Minimum notice and advance window are per resource with no global default;
  blank means no limit (simplest of: per resource, global, or per category).
- Rules are managed under Admin → Resources (*Recurring availability rules*,
  and *Booking limits* per resource) rather than on a new page.

**On the availability calendar.** The public calendar feed returns each
resource's rules, and the calendar evaluates them with the same shared code
the server uses: times outside opening hours, inside a recurring restriction,
or outside the notice and advance windows are shown light grey as *Not
bookable* and cannot be selected (hovering gives the reason). Days with no
bookable time are grey in month view. The server still checks every booking.

## FR04 – Provisional bookings & automatic expiry

**Statuses.** `provisional` and `expired` join the Release 1 statuses.
Bookings gain `expires_at`; resources gain `provisional_expiry_hours`.

**Workflow.** On the booking form a customer ticks *Hold this time
provisionally*. The request goes through exactly the same validation and
atomic insert as any booking (pricing, restrictions, closures, conflicts), is
stored as `provisional` with an expiry, and the customer gets the *provisional
booking* email. An administrator with `bookings.approve` confirms it from
Admin → Bookings (*Confirm*). Confirmation revalidates conflicts and closures
in the same guarded UPDATE as Release 1 approvals, and is refused once the hold
has lapsed. The customer gets the confirmation email (not the "approved" one,
so they never receive both). Customers and admins can cancel a live hold.

**Expiry period.** Global setting *Provisional booking hold (hours)* (Admin →
Settings, default 48) → per-resource override (Admin → Resources → *Booking
limits*) → per-booking override by an admin with `bookings.manage`, either
when booking for a customer or afterwards with *Change hold*. A hold never
runs past the booking's own start time.

**Release and idempotency.** Availability SQL counts a provisional booking as
active only while `expires_at` is in the future (`activeBookingSql`), so the
resource is released at the expiry instant, whether or not the scheduler has
run, and a concurrent request can never slip past a live hold (the atomic
insert evaluates the same condition). APIs report a lapsed hold as `expired`
straight away. The scheduler then marks it `expired` with a status-guarded
UPDATE, writes the `expired` event only if that UPDATE changed the row, and
sends the *provisional expiry* email with a per-booking dedupe key. Running
it twice, or two runs overlapping, does nothing extra. An expired hold cannot
be confirmed or extended, so it can never be revived over a later booking.
Expired bookings stay in every booking list as history.

**Scheduler Worker.** Pages Functions cannot run on a Cron Trigger, so
`workers/scheduler` is a small separate Worker (chosen as the simplest of: a
separate Worker sharing the D1 database and library code, a Worker that calls
a secret-protected Pages endpoint, or an external cron service). It runs every
5 minutes against the same D1 database. It is deployed separately from Pages:

```sh
npm run scheduler:deploy   # wrangler deploy --config workers/scheduler/wrangler.toml --env production
```

When email sending is configured, give the Worker the same `EMAIL_PROVIDER`,
`EMAIL_FROM`, `MS_TENANT_ID`, `MS_CLIENT_ID` and `EMAIL_API_KEY` as the Pages
project (see *Sending email through Office 365* in the README)
(`npx wrangler secret put EMAIL_API_KEY --config workers/scheduler/wrangler.toml --env production`).

## FR05 – Recurring bookings

**Data.** `recurrence_series` stores the requested pattern (frequency,
monthly mode, first date, UK start/end times, end date or count, and the
dates the customer chose to leave out). Each occurrence is an ordinary
booking with `series_id`, so pricing, approval, availability, cancellation
and history behave exactly as for single bookings.

**Patterns** (`src/shared/recurrence.ts`): daily, weekly, fortnightly and
monthly, ending on a date or after a number of bookings (at most 104).
Monthly repeats either on the same date (months without that date, such as
31 February, are skipped) or on the same weekday position ("first Monday",
"last Friday"). Times are UK wall-clock, so 19:00 stays 19:00 across BST.
An end time at or before the start runs into the next morning.

**Review and submit.** *Repeat this booking* on the booking form shows every
date with its price or the reason it is unavailable (past, closure, clash
through the conflict matrix, availability rule or advance limit, no price),
and the total. If any date is unavailable the customer either changes the
pattern or explicitly ticks *Remove these dates and continue*. The API
re-validates on submit and refuses (409, with every date's status) unless
each unavailable date is in `exclude_dates`. All bookings in the series are
written in one guarded batch: each uses the same conditional insert as a
single booking, and the batch rolls back if any of them lost a race, so a
series is never partially created. Each date is priced at the rate effective
on that date. One email covers the whole series.

**Management.** `/series/:id` lists every date. Customers (and organisation
managers) can cancel one upcoming date, a date and every later one, or the
whole series. Administrators with `bookings.manage` can also change the time
(and optionally the resource) of one date or of a date and every later one.
Every changed date is revalidated, repriced and recorded as an `amended`
event, all-or-nothing (`functions/_lib/amend.ts`, which FR12 also uses).

**Decisions.**

- Rules, busy periods and prices are loaded once per series rather than per
  date, so a 104-date series stays well inside D1's per-request query limits.
  The pricing engine was refactored into `loadPricingContext` +
  `quoteFromContext` for this, and single-booking quotes use the same code.
- Provisional holds and restriction overrides apply to single bookings only;
  an admin can override a single date afterwards by changing it.
- Changing future dates keeps each date and applies the new times.

## FR12 – Customer booking management & amendments

**My Bookings** shows personal bookings and those of every organisation the
customer belongs to, with *Upcoming / Past / All* and a status filter, and a
*change requested* marker. Booking details show the change history.

**Requesting a change.** On an upcoming active booking, the customer (or an
Organisation Manager for organisation bookings; members can only view)
chooses *Request a change*, picks a new resource, date and times, and checks
it. The server validates it exactly like a new booking, ignoring the booking
itself so it can move within or overlapping its own slot, and returns the
new price breakdown and the difference. Submitting stores a pending
`booking_amendments` row with the quoted price. A partial unique index allows
one pending request per booking. The original booking is untouched and stays
reserved. The customer can withdraw a pending request, and cancelling the
booking withdraws it automatically.

**Decision** (Admin → Bookings → *Change requests*, `bookings.approve`).
Approval revalidates availability and applies the change in one guarded
batch: the booking's resource, times and price, its allocation row, an
`amended` event recording before and after, and the request's status. If the
new time has been taken meanwhile nothing changes and the admin is told.
Rejection records who rejected it and an optional message. The customer is
emailed either way (*booking amended* / *change not approved*).

**Decisions.**

- The customer pays the price quoted when they made the request, even if
  prices change before approval (the alternative was re-pricing at approval,
  which would charge a price the customer never saw).
- The booking keeps its status on approval; the admin's approval of the
  change stands in for resource approval.
- Only upcoming bookings can be changed by customers. Admins change series
  dates directly (FR05) using the same code.

## FR06 – Advanced email template management

**Templates.** Defaults for every email live in `src/shared/email-templates.ts`
(booking request received, approved, rejected, confirmation, amendment,
change not approved, cancellation, provisional booking, provisional expiry,
payment reminder, organisation invitation, password reset). Admins with
`email_templates.manage` edit them under Admin → Emails: subject, plain-text
body, optional HTML body, parameter buttons that insert `{{ name }}` at the
cursor, a live preview with example values, *Send test to me*, *Restore
default*, and an on/off switch. A saved version is a row in `email_templates`;
deleting it restores the default. Unknown parameters are refused on save so
typos are caught. Invitation and password reset emails cannot be switched
off, because the features depend on them.

**Parameters.** Every email can use `customer_name`, `customer_email`,
`venue_name` and `contact_email` (the last two from Settings); booking emails
add `organisation_name`, `booking_reference`, `resource_name`,
`booking_date`, `booking_start_time`, `booking_end_time`, `booking_cost` and
`booking_status`; some templates add their own (for example `expiry_date`,
`decision_note`, `payment_instructions`). Values are HTML-escaped in the HTML
output and have line breaks removed in subjects, so names and notes typed by
users cannot inject markup or headers. Every email is sent as both HTML and
plain text.

**Lifecycle.** Each booking event sends exactly one email: auto-confirmed
bookings get *confirmation*, approval of a request gets *approved* (never
both), confirming a provisional hold gets *confirmation*. Disabled templates
are recorded in the history as *not sent* and are not sent later.

**History and retries.** `email_events` now records the subject, booking
reference, provider reference (Resend's id), sending time, attempts and
retry state; Admin → Emails → *History* shows it with search and a status
filter. Rate limits and provider errors (HTTP 429/5xx, network errors) are
retried by the scheduler Worker after 5, 10, 20 and 40 minutes (5 attempts in
all). Each retry claims the row with a status-guarded UPDATE and the provider
gets an idempotency key, so retries never produce duplicates. Template
parameters are kept only while a retry is pending, and never for invitation
or password reset emails, whose links are single-use secrets.

**Office 365.** With `EMAIL_PROVIDER=office365` emails are sent from the
`EMAIL_FROM` mailbox through Microsoft Graph using an app-only token
(client credentials, cached until shortly before expiry). Throttling (429),
outages (5xx) and an expired token (401) are retried; refused requests and
missing configuration are recorded as failed and not retried. Graph has no
idempotency key, so a send whose response was lost in transit could in rare
cases be delivered twice on retry. Setup steps are in the README.

**Payment reminder.** Admins with `bookings.manage` can send one from a
confirmed, chargeable booking's page. Payment itself remains out of scope.

## FR09 – Consolidated admin calendar

**Views.** Admin → Calendar shows every resource on one calendar in day, week
or month view, in UK time, with weeks starting on Monday. The day and week
views draw bookings on a time grid (06:00 to midnight); bookings that run
past midnight continue on the next day and are marked as such. The month view
lists each day's bookings compactly. *Today*, previous and next move by the
current view. Phones open on the day view, larger screens on the week view.

**Filters.** Resources (each with its own colour), status, organisation and
customer, plus *Include cancelled and expired*. Status is shown by the
booking's border (solid confirmed, dashed awaiting approval, dotted
provisional, faded and struck through for inactive) so colour stays free for the resource.
Recurring bookings carry a ↻ marker, and resource closures appear hatched.

**Acting from the calendar.** Clicking a booking opens a panel with its
details, links to the booking, customer, organisation and repeating series,
and *Approve* (or *Confirm* for a provisional hold) buttons for admins with `bookings.manage`.
Admins with `bookings.create` can click an empty slot in day or week view to
open *Book for a customer* pre-filled with that resource and time; viewers
get a read-only calendar. Every action goes through the existing endpoints, so
the same validation and permission checks apply.

**Data.** No new tables. `GET /api/admin/bookings` gains `resource_ids`
(comma-separated), `user_id` and `active_only=1` filters, returns
`resource_id` and `series_id`, and allows up to 2000 rows so a month of every
resource loads in one request.

## FR07 – Physical asset management

**Register.** Admin → Assets (permission `assets.manage`, held by Super Admins
and Booking Admins; Viewers cannot see it) lists every key, fob, card and item
of loaned equipment with its type, serial or reference number, status and
current holder, with filters by status and type and a search across name,
reference and holder. Reference numbers are optional but unique (ignoring
case) when given. Asset types are configurable under *Asset types*: Key fob,
Physical key, Access card and Loaned equipment are seeded; a type can be
renamed, reordered or retired, and retired types keep their assets but cannot
be chosen for new ones.

**Statuses.** Available, Assigned, Lost, Damaged and Retired. *Assigned* is set
only by an assignment and cleared only by recording the return, so the history
always matches the status. Administrators can otherwise change the status
directly, for example to retire a fob or mark a lost key as found.

**Assigning and returning.** Opening an asset shows *Assign to someone*
(search for a registered user, optional notes) or, when it is on loan, *Record
return* with an outcome: *Returned* (becomes available), *Returned damaged*
or *Reported lost*. The *On loan* tab is the list of outstanding assignments.
Lost and retired assets cannot be assigned; damaged ones can (decision: a
scuffed fob still opens the door, and the form warns the administrator).
Assignment checks the status, writes the history row and sets the status in
one guarded batch, and a partial unique index on open assignments means an
asset can never be with two people at once, even when two administrators
act simultaneously.

**History.** `asset_assignments` keeps every loan: who had it, who assigned it
and when, who recorded the return and when, the outcome, and the notes from
both ends. Rows are never deleted. Users see the items currently lent to them
under My account → *On loan to you*.

## Several resources in one booking

On the booking page, *Add more resources at the same time* lets a customer
book, for example, the Main Hall and the Kitchen together. Each extra resource
is checked and priced live, and a combined total is shown.
`POST /api/bookings` accepts `additional_resource_ids`.

**Decision: one booking per resource, linked by a group.** Each resource keeps
its own booking row, reference, price and approval, so approval stays per
resource as agreed: a hall that needs approval waits for it, while the
kitchen booked with it can be confirmed at once. Changes and cancellations
also work per resource. `bookings.group_id` links them, and the booking page
lists the bookings made together. The alternative, one booking spanning
several resources, would have forced a single status and price on resources
with different rules.

**All or nothing.** Every resource is validated exactly as a single booking
(rules, closures, notice, provisional holds), then all of them are inserted
in one guarded batch: if any resource is taken meanwhile, nothing is booked.
Resources that include each other (a hall and the Whole Venue) cannot be
combined. The customer gets one email per outcome (confirmed, awaiting
approval, provisional) naming every resource it covers, rather than one
email per resource. Recurring bookings remain single-resource.

## One full price per resource, with group discounts

**Before.** Admins entered a separate price for every resource and price
group, so a price change meant editing up to three rows per resource.

**Now.** Each resource has one full price (`base_rates`: charging model,
amount, effective from/to, active), which the general public pays. Each
pricing category has a percentage discount off it
(`pricing_categories.discount_bp`, in basis points, 0 to 10000): 0% pays
full price, 25% pays a quarter less, 100% is free. The pricing engine takes
the customer's (or organisation's) group discount off the full price,
rounded to the penny, before the separate dated discounts and organisation
arrangements, which work as before. Admin → Pricing → Prices sets the full
price and previews what each group pays; Admin → Pricing → Categories sets
each group's discount.

**Migration 0014.** The full price is the price of the highest-ordered
category that priced each resource (General Public), so public prices are
unchanged. Each other category's discount is 100% less the average of its
old price divided by the public price, over the resources where both were
in force with the same charging model, rounded to a whole percent. With
the seed prices that gives Scouts 58% off and Community 32% off, so some
Scouts and Community prices move a little (Scouts Main Hall was £10.00/h,
now £10.50/h; Scouts Small Hall was £5.00/h, now £6.30/h). Existing
bookings keep the price agreed when they were made. `pricing_rates` is
kept but no longer read.

## Shrinking large images on upload

Images over 5 MB (and any HEIC/HEIF photo) are resized in the browser to at
most 2560 px on the long edge and recompressed (JPEG, or WebP for PNG/WebP
so transparency survives), stepping down in size and quality until they
fit under 5 MB. The server limit is unchanged. Limits: HEIC/HEIF photos can
only be read by Safari, so other browsers ask for a JPEG, PNG or WebP
instead; an animated image that has to be shrunk keeps only its first frame.
