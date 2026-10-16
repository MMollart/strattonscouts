# Release 3 – Venue Management, Governance & Integrations

This document records what Release 3 adds, how each feature builds on the
Release 1 and 2 code, and the implementation decisions taken where the
specification left a detail open. Each feature has its own migration, safe to
apply (`npm run db:migrate:remote`) before the code that uses it is deployed.

| Migration | Feature |
| --- | --- |
| `0017_audit_events.sql` | FR11 Booking & administration audit history |

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
