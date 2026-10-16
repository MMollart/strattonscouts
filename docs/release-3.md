# Release 3 – Venue Management, Governance & Integrations

This document records what Release 3 adds, how each feature builds on the
Release 1 and 2 code, and the implementation decisions taken where the
specification left a detail open. Each feature has its own migration, safe to
apply (`npm run db:migrate:remote`) before the code that uses it is deployed.

| Migration | Feature |
| --- | --- |
| `0017_audit_events.sql` | FR11 Booking & administration audit history |
| `0018_maintenance.sql` | FR22 Resource maintenance & fault management |
| `0019_agreements.sql` | FR20 Booking agreements & digital acceptance |
| `0020_financial_reporting.sql` | FR10 Financial reporting |
| `0021_calendar_feeds.sql` | FR17 External calendar integration |

## FR11 – Booking & administration audit history

**One log.** `audit_events` holds every significant change: when, who (user id
and actor type: customer, administrator or system), the action
(`booking.approved`, `pricing.rate_updated`, …), the record (type, id and a
readable label such as the booking reference or resource name), the changed
values before and after (JSON, only the fields that changed), the reason where
one was given, and the related booking, organisation and resource. It has no
foreign keys, so history outlives the records it describes.

**How changes reach it.**

- *Bookings.* Every booking lifecycle change already wrote a `booking_events`
  row (created, confirmed, approved, rejected, cancelled, expired, amended,
  change requested/rejected/withdrawn, hold expiry changed, recurring series
  changes). A trigger copies each new row into `audit_events` in the same
  transaction, so no booking change can skip the audit. `booking_events.detail`
  now carries `from`/`to` values (status before and after a transition, the old
  and new time/resource/price of an amendment) and a `note` (the reason).
  Provisional expiry by the scheduler has no actor and is recorded as *system*.
- *Administrator roles.* The same for `admin_role_events`.
- *Everything else* goes through `audited()` in `functions/_lib/audit.ts`: it
  reads the row before and after the write and records the fields that
  differ, or nothing if the save changed nothing. Covered: resources (create,
  edit, activate/deactivate, hierarchy, booking limits, images), availability
  rules, closures, base prices, discounts, price groups, organisation pricing
  (including free arrangements), organisations, memberships, Organisation
  Manager assignments, invitations, users' price groups, settings, email
  templates, assets (create, edit, status, assignment, return) and asset types.
  Later Release 3 features (maintenance, agreements, calendar feeds) use the
  same helper.
- *Existing history* in `booking_events` and `admin_role_events` is copied in by
  the migration, oldest first.

**What is never logged.** Passwords, token hashes, API keys, cookies, phone
numbers and email addresses are replaced by `[redacted]` (the log still says
that the field changed). Users are referred to by id; names are looked up when
the log is displayed. Email template bodies are not copied.

**Append-only.** Triggers refuse `DELETE` and refuse `UPDATE` except the
one-off seal described next. There is no endpoint that changes or deletes an
audit record.

**Tamper evidence.** Each record is *sealed* by storing a SHA-256 hash of its
content chained to the previous record's hash. The scheduler seals new records
every five minutes, and the audit screens seal before they display. *Check
integrity* (Admin → Audit history) recomputes the chain and names the first
record that no longer matches. Someone with direct database access can still
drop the triggers and rewrite the whole chain, so the log is tamper-evident,
not immutable; the documentation and the screen say no more than that.

**Screens.**

- *Admin → Audit history* (`/admin/audit`): filter by date range (UK dates),
  user, actor type, organisation, record type, action area, booking reference
  and free text; expand an event to see before and after values. CSV export
  of the current filter (Super Admin).
- *History* sections on a booking (for administrators), an organisation (for
  administrators), and each resource (Admin → Resources, which includes its
  prices, rules, closures and maintenance).

**Permissions.**

| | Super Admin | Booking Admin | Viewer |
| --- | :-: | :-: | :-: |
| View audit history | ✓ (`audit.view`) | ✓ (`audit.view`) | Restricted |
| Check integrity | ✓ | ✓ | |
| Export audit history | ✓ (`audit.export`) | | |

*Restricted* means a Viewer sees who changed which record and when, but not the
values or reasons.

### Decisions

- *Where to record changes:* (a) one call per endpoint after the write, (b)
  database triggers on every audited table, (c) triggers on the two existing
  event tables plus a before/after helper for the rest. Chose (c): booking
  changes, the most important, are audited atomically wherever they happen,
  while ordinary edits get exact field-level diffs without a trigger per table.
- *Tamper evidence:* (a) none, (b) a per-row hash, (c) a hash chain sealed in
  the background. Chose (c): a per-row hash does not reveal a deleted row, and
  sealing in the background keeps the hash out of every write path.
- *Viewer "restricted" access:* (a) no access, (b) bookings only, (c) the full
  list without values or reasons. Chose (c): it lets a Viewer see that
  something changed without exposing amounts, notes or personal details.
- *Account status changes:* the platform has no account suspension yet, so
  there is nothing to audit; administrator role changes and price group
  corrections are audited.
- *Retention:* audit records are kept indefinitely for now. A retention
  period should be agreed as part of the UK GDPR review; because records are
  append-only, deleting old ones will need a deliberate, documented database
  operation.

## FR22 – Resource maintenance & fault management

**Records.** A maintenance record has a reference (`MNT-…`), the resource, a
title and description, a type, start and end (entered in UK time), a status
(planned, in progress, completed, cancelled), whether it blocks availability,
an assigned administrator and internal notes. Records are never deleted;
completed and cancelled work stays as history. Types are managed under
*Admin → Maintenance → Maintenance types*; six are seeded (planned, emergency,
repair, inspection, cleaning, other). A retired type stays on existing records
but cannot be chosen for new ones.

**Blocking uses the existing engine.** Maintenance that blocks availability
owns one row in `resource_closures` (linked by `maintenance_id`). The row
exists while the work is planned or in progress and is removed when it is
completed or cancelled, or when blocking is switched off. Because it is an
ordinary closure, the one availability engine applies it everywhere: new
bookings, approvals, amendments, recurring series and the public calendar,
with the resource hierarchy (maintenance on the Main Hall makes the Whole
Venue unavailable; maintenance on the Whole Venue makes every part of it
unavailable; siblings are unaffected). Such closures cannot be removed from
the closures list; they follow their maintenance record.

**Existing bookings are never cancelled.** If blocking maintenance overlaps
active bookings (on the resource, anything it is part of, or anything part of
it), saving is refused with the list of bookings. The administrator can save
anyway by acknowledging them and giving a reason; the reason is stored on the
record and in the audit log, and each booking is listed on the record as
*needs action* until the administrator marks it resolved (with a note, for
example "moved to the Small Hall"). Bookings already reviewed for a record do
not need a new exception when it is edited. If someone books the period
between the review and the save, the save is refused and the conflicts shown
again.

**Notifying customers.** *Email affected customers* sends the new
*Maintenance notice* email template (editable under Admin → Emails, same
five-box layout as the other emails) with an optional message. Each customer
is emailed once per version of the record, so pressing it twice does not send
twice, but a later change can be announced again.

**Faults.** A fault has a reference (`FLT-…`), resource, description,
severity (low, medium, high, critical), status (open, being fixed, resolved,
closed), when and by whom it was reported, and resolution notes. A fault
marked *prevents bookings* (ticked automatically for critical faults) closes
the resource, through the same closure mechanism and hierarchy, from when it
was reported until it is resolved or closed. Existing bookings are kept and
listed so they can be followed up.

**Calendar.** The admin calendar shows maintenance in orange stripes,
distinct from bookings and from grey closure hatching, with filters for
status and type alongside the existing resource and date controls. Clicking
it opens the maintenance record. *Admin → Maintenance* lists records with
filters for resource, type, status and date range.

**Audit.** Creating, editing, starting, completing and cancelling
maintenance, saving over bookings (with the reason), resolving affected
bookings, notifying customers, maintenance type changes, and reporting,
updating and resolving faults are all recorded in the audit history.

**Permissions.**

| | Super Admin | Booking Admin | Viewer |
| --- | :-: | :-: | :-: |
| View maintenance and faults | ✓ | ✓ | ✓ |
| Schedule maintenance, report faults, notify customers (`maintenance.manage`) | ✓ | ✓ | |

### Decisions

- *How maintenance blocks bookings:* (a) a separate maintenance check in the
  availability code, (b) a closure row owned by the record. Chose (b): there
  is still one availability engine, so the hierarchy and every booking path
  apply without new code, and the public calendar shows the time as closed
  without revealing why.
- *Faults that prevent bookings:* block from when the fault was reported
  until it is resolved, rather than asking for an end date the administrator
  does not know yet.
- *Who can manage maintenance:* Super Admins and Booking Admins, as they run
  day-to-day availability; Viewers can see it.
- *Attachments* (spec §9, "where appropriate") are not added yet; photos and
  contractor documents can follow using the R2 upload used for agreements.

## FR20 – Booking agreements & digital acceptance

**Templates and versions.** Admin → Agreements holds agreement templates
(for example hire conditions or a safeguarding policy). Each has numbered
versions with formatted text (headings, lists, bold, italic and links, using
a small safe syntax rendered without HTML), an effective date and time (UK),
an optional note of what changed, and an optional PDF. A published version
can never be edited or deleted (database triggers refuse it); changing the
wording means publishing a new version. Each version stores a SHA-256 hash of
its title, text and PDF.

**Where they apply.** A template applies to every booking, or to the
resources it is assigned to and everything that is part of them (an
agreement on the Whole Venue applies to the Main Hall; one on the Kitchen
does not apply to the Whole Venue). A booking of several resources, or a
recurring series, needs every agreement that applies to any of them. The
version required is the latest whose effective date has passed, so a new
version can be scheduled in advance. Templates can be retired; bookings then
stop asking for them and past acceptances are kept. Until an agreement is
published, bookings work exactly as before.

**Accepting.** The booking form shows the text of each agreement with its own
unticked checkbox (never preselected), a link to the PDF where there is one,
a typed full-name signature and an optional drawn signature (saved as a PNG).
The server checks that every applicable version was accepted and signed; if
a newer version came into effect while the form was open, it refuses and the
form shows the new version to accept. Acceptances are written in the same
transaction as the booking, so a booking that loses a race leaves no
acceptance behind. Each acceptance records the booking, the version, the
content hash, who accepted, when, and the signature. One signature is stored
per act of accepting and shared by its acceptances, so a 40-week series does
not store the drawing 40 times. Acceptances and signatures cannot be changed
or deleted, and each one is copied into the audit history by a trigger.

**On behalf of a customer.** When an administrator books for a customer, they
accept on the customer's behalf; the acceptance records the administrator as
the person who accepted and the customer as the person it was for.

**Change requests.** A change request asks for acceptance only when the
change brings in a version the booking has not already accepted: moving to a
resource with a different agreement, or after a new version took effect.
Those acceptances are linked to the change request. Administrator-made
changes do not ask the customer to accept anything.

**Viewing.** Each booking page lists the agreements accepted for it, with the
exact wording of the accepted version, when and by whom, and the content
hash. The customer, organisation managers and administrators who manage
bookings also see the typed name and drawn signature. Admin → Agreements
shows each template's versions, where it applies, and who has accepted it.

**Documents.** PDFs are stored in R2 under `agreements/`, which the public
image route does not serve. They are only downloaded through
`/api/agreements/versions/:id/pdf`, which requires a signed-in user and is
never cached publicly. Files must be real PDFs (checked by content) of 10 MB
or less.

**Permissions.**

| | Super Admin | Booking Admin | Viewer |
| --- | :-: | :-: | :-: |
| Create agreements, publish versions, assign resources (`agreements.manage`) | ✓ | | |
| View agreements, versions and acceptances | ✓ | ✓ | ✓ |
| See typed names and drawn signatures | ✓ | ✓ | |

### Decisions

- *Which version applies:* (a) the version in effect when the booking is
  made, (b) the version in effect on the booking date. Chose (a): the
  customer accepts the terms they are shown at the time they book.
- *Agreements on parent resources:* apply to everything that is part of the
  resource, matching how the hierarchy already works for availability.
- *Formatted text:* (a) rich HTML, (b) a small Markdown-like syntax rendered
  without HTML. Chose (b): administrators can format and link, and nothing
  typed can run as script in a customer's browser.
- *Viewer restricted view:* Viewers see which agreement and version was
  accepted and when, but not the typed name or drawn signature.
- *Administrator changes to a booking* do not ask for re-acceptance, because
  the customer did not make the change; a customer change request does.

## FR10 – Financial reporting

Admin → **Booking values** (`/admin/finance`) reports the value of bookings,
worked out from the price snapshot stored on each booking (integer pence:
`total_amount_pence`, `base_amount_pence`, `discount_pence`). The page and
the CSV both say clearly that these are booking values, not payments
received.

- `GET /api/admin/finance` (`finance.view`) returns totals, count and average
  for each status, discounts, breakdowns by resource, price group and
  organisation, and a chart series.
- `GET /api/admin/finance/export` (`finance.export`) returns the bookings
  behind the report as CSV, with the same filters, and records a
  `finance.exported` audit event.
- Filters: this month, last month, this year, last year or a custom range
  (up to three years), all in UK time; resource; price group; organisation
  (or personal bookings only).

### Statuses

Confirmed, provisional, awaiting approval and cancelled are totalled
separately and never added together. Rejected bookings and provisional holds
that have expired are reported on one line underneath and are not in any
total. Discounts and free bookings are counted for confirmed bookings only.

### Which period a booking counts in

By default value is counted on the **days the booking is used**. A booking
over several UK days is shared between them in proportion to its time on
each day, using a largest-remainder split so the parts are whole pence and
always add up to the booking's value: a camping weekend over the end of a
month is split between the two months, and the two reports reconcile. The
**Count value on** filter can instead count each booking's whole value on the
day it was made.

### Permissions

| | Super Admin | Booking Admin | Viewer |
| --- | :-: | :-: | :-: |
| View the report (`finance.view`) | ✓ | ✓ | ✓ |
| Export CSV (`finance.export`) | ✓ | ✓ | |

### Decisions

- *Default attribution:* usage date, as the spec prefers; booking date is
  available as an option.
- *Splitting multi-day bookings:* by time used on each day, not evenly by
  day, so an overnight booking that ends at 06:00 puts most of its value on
  the first day.
- *Chart:* confirmed value only, by day for periods up to 62 days and by
  month for longer ones, with provisional and pending shown in the tooltip
  and the table view. Charting several statuses together would invite
  adding them up.
- *Migration 0020* only adds two indexes and the `finance.export`
  permission, so it is safe to run before the code deploys.

## FR17 – External calendar integration

### One booking

Each booking page has **Add to your calendar** (only while the booking holds
its resource: confirmed, provisional or awaiting approval):

- **Download calendar file (.ics)** from `GET /api/bookings/:id/calendar`,
  for anyone who can see the booking. Works with Apple Calendar, Outlook and
  other iCalendar apps.
- **Google Calendar**, **Outlook (work or school)** and **Outlook.com** links
  that open a pre-filled new event.

The entry has the reference, resource, venue, date and times, the venue
address (new optional setting **Venue address**), the status and a link back
to the booking. Booking pages are also the confirmation page, so this covers
both.

### Subscriptions

A subscription is a read-only iCalendar URL,
`/api/feeds/<secret>.ics`. The secret is 256 random bits. Only its SHA-256
hash is stored (`calendar_feeds.token_hash`), so the full URL is shown once
when it is created or replaced, with Copy, "Open in calendar app" (webcal)
and "Add to Google Calendar" buttons.

| Feed | Who creates it | What it shows |
| --- | --- | --- |
| Personal (My account) | any signed-in customer | bookings they made, naming the organisation if any |
| Organisation (organisation page) | the organisation's managers | the organisation's bookings, no customer names |
| Venue (Admin → Calendar subscriptions) | `calendar.manage` | all resources, or chosen ones (each including what is part of it); names only if "Show who booked" is ticked |

- Feeds contain bookings that currently hold their resource, from 90 days
  ago onwards. Cancelled, rejected and expired bookings are left out, so the
  calendar app removes them at its next refresh. Each booking keeps one UID,
  so an amendment moves the existing entry, and `SEQUENCE` rises with each
  change. Recurring series are ordinary bookings, so they appear and change
  the same way.
- Times are written with `TZID=Europe/London` and a VTIMEZONE block, so
  entries stay at the right local time across the clocks changing.
- Nothing private is included: no phone numbers, emails, notes, prices or
  admin comments.
- A feed stops working (404, with no reason given) when it is revoked or
  replaced, when its organisation-feed owner stops being a manager, or when
  its venue-feed owner loses `calendar.manage`.
- **Replace link** issues a new secret; the old URL stops at once.
  **Revoke** stops the URL and keeps the record. Owners can manage their
  own feeds, any manager can manage the organisation's, and `calendar.manage`
  can manage everyone's from the admin page.
- Feeds are cached privately for 5 minutes and suggest an hourly refresh.
  Calendar apps decide how often they check, so the UI never promises
  immediate updates. Changing an entry in a calendar app changes nothing
  here.
- Creating, replacing and revoking are audited (`calendar.feed_*`).

### Permissions

| | Super Admin | Booking Admin | Viewer | Customer |
| --- | :-: | :-: | :-: | :-: |
| Download a booking they can see / personal feed | ✓ | ✓ | ✓ | ✓ |
| Venue feeds, manage everyone's feeds (`calendar.manage`) | ✓ | ✓ | | |

### Decisions

- *Cancelled bookings in feeds:* (a) keep them with `STATUS:CANCELLED`,
  (b) leave them out. Chose (b): subscriptions are a full snapshot, and every
  major calendar app removes events that disappear from one, whereas apps
  treat `STATUS:CANCELLED` inconsistently. A downloaded .ics for a
  cancelled booking is marked cancelled.
- *Showing the URL once:* the URL is a credential, so it is treated like a
  password. Lose it and use Replace link.
- *Personal feeds* show only bookings the person made, not every booking of
  each organisation they belong to; managers have the organisation feed.
- *Multi-resource bookings* appear as one entry per resource, matching how
  they are stored and cancelled.
- *Migration 0021* adds a table, the permission and nothing else, so it is
  safe to run before the code deploys.
