# Release 2 – Organisations, Operations & Booking Automation

This document records what Release 2 adds, how each feature is built on top of
the Release 1 code, and the implementation decisions taken where the
specification left a detail open. Each feature has its own migration so they
can be applied incrementally (`npm run db:migrate:local` / `:remote`).

| Migration | Feature |
| --- | --- |
| `0003_admin_roles.sql` | FR08 Advanced admin roles & permissions |

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
