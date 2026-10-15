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

**Precedence** (applied in `loadOrganisationArrangement` and `computePrice`):

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
