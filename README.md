# Stratton Scouts – Resource Booking Platform 

A Scouts-branded resource booking website for Stratton Scouts, built entirely on
the Cloudflare developer platform. Customers can browse facilities, check live
availability, register, and book resources; administrators manage resources,
pricing, availability, the conflict matrix, and booking approvals.

> **Release 2** adds organisations, advanced pricing and availability rules,
> provisional and recurring bookings, amendments, configurable email templates,
> a consolidated admin calendar, asset tracking and granular admin roles. See
> [docs/release-2.md](docs/release-2.md). Online payments remain out of scope.

## Tech stack

| Concern            | Technology                                          |
| ------------------ | --------------------------------------------------- |
| Hosting            | Cloudflare Pages                                    |
| Frontend           | React + TypeScript + Vite + Tailwind CSS            |
| Backend/API        | Cloudflare Pages Functions (`functions/`)           |
| Database           | Cloudflare D1 (SQLite)                              |
| File storage       | Cloudflare R2 (resource images)                     |
| Auth               | WebCrypto (PBKDF2) + HttpOnly session cookies       |
| Email              | Pluggable transactional provider (Resend/console)   |
| Tooling            | Wrangler, Vitest, ESLint                            |

There is **no** separately hosted backend, PostgreSQL, Supabase, or Firebase —
everything runs on Cloudflare.

## Project structure

```
migrations/            D1 schema (0001_init.sql) and seed data (0002_seed.sql)
src/                   React frontend
  shared/              Pure, isomorphic logic shared with the API
    pricing.ts         Pricing engine (hourly/nightly/fixed, integer pence)
    availability.ts    Conflict + availability engine
    validation.ts      Zod schemas shared by client and server
    types.ts           Shared domain types
  pages/               Route components (public, account, admin/*)
  lib/                 API client, auth context, data hooks
  components/          Layout + shared UI
functions/             Cloudflare Pages Functions (the API, under /api/*)
  _lib/                Backend helpers (auth, crypto, booking, email, …)
  api/                 File-routed endpoints
tests/                 Vitest suites (pricing, availability, booking concurrency)
```

## Prerequisites

- Node.js 18+
- A Cloudflare account (for deployment and remote D1/R2)
- `wrangler` (installed as a dev dependency)

## Local development

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Configure environment**

   Copy the example secrets file and fill in values for local development:

   ```bash
   cp .dev.vars.example .dev.vars
   ```

   | Variable               | Purpose                                                        |
   | ---------------------- | -------------------------------------------------------------- |
   | `APP_BASE_URL`         | Base URL used in emails / password-reset links                 |
   | `EMAIL_PROVIDER`       | `console` (logs emails), `office365` (Microsoft Graph) or `resend` |
   | `EMAIL_API_KEY`        | Provider API key; for `office365`, the app registration's client secret (**secret**) |
   | `EMAIL_FROM`           | From address; for `office365`, the mailbox that sends (e.g. a shared mailbox) |
   | `MS_TENANT_ID`         | `office365` only: the Microsoft 365 tenant (directory) ID       |
   | `MS_CLIENT_ID`         | `office365` only: the app registration's application (client) ID |
   | `DATA_ENCRYPTION_KEY`  | Key used to encrypt contact details at rest (**secret**; required in production, the API refuses requests without it) |
   | `BOOTSTRAP_ADMIN_TOKEN`| One-time token guarding the initial Super Admin bootstrap (**secret**) |

   > `.dev.vars` is git-ignored and must never be committed.

3. **Create local D1 + apply migrations and seed data**

   ```bash
   npm run db:migrate:local
   npm run db:seed:local
   ```

   The seed creates the three pricing categories (Scouts / Community / Public),
   the six resources (Whole Venue, Small Hall, Main Hall, Kitchen, Event Field,
   Camping), illustrative prices, and the mandatory conflict matrix
   (self-conflicts plus the Whole Venue relationships). Migration 0014 turns
   those prices into one full price per resource (the public price) and a
   discount per pricing category; see docs/release-2.md.

4. **Run the frontend dev server**

   ```bash
   npm run dev
   ```

5. **Run the full stack (Functions + D1 + R2) locally**

   Build first, then serve with Wrangler so the `/api/*` functions are live:

   ```bash
   npm run build
   npm run pages:dev
   ```

### Creating the first administrator

Admin accounts are not self-service. With `BOOTSTRAP_ADMIN_TOKEN` configured and
while **no** Super Admin exists yet, create the first Super Admin:

```bash
curl -X POST http://localhost:8788/api/admin/bootstrap \
  -H 'content-type: application/json' \
  -d '{"token":"<BOOTSTRAP_ADMIN_TOKEN>","full_name":"Group Admin","email":"admin@example.org","phone":"07000000000","password":"change-me-please"}'
```

The endpoint refuses to run once a Super Admin exists. Thereafter, Super Admins
assign the Super Admin, Booking Admin or Viewer role from **Admin →
Administrators**. See [docs/release-2.md](docs/release-2.md#fr08--advanced-admin-roles--permissions)
for what each role can do.

## Scripts

| Script                     | Description                                   |
| -------------------------- | --------------------------------------------- |
| `npm run dev`              | Vite dev server (frontend)                    |
| `npm run build`            | Type-check and build the production bundle     |
| `npm run typecheck`        | TypeScript type-check only                     |
| `npm run lint`             | ESLint over `.ts`/`.tsx`                       |
| `npm test`                 | Run the Vitest suite once                      |
| `npm run test:watch`       | Run Vitest in watch mode                       |
| `npm run pages:dev`        | Serve the built app + Functions with Wrangler  |
| `npm run db:migrate:local` | Apply migrations to local D1                   |
| `npm run db:migrate:remote`| Apply migrations to the production D1          |
| `npm run db:seed:local`    | Load seed data into local D1                   |

## Testing

```bash
npm test
```

The most important suite, `tests/booking-allocation.test.ts`, runs the booking
engine against a **real D1 database** (workerd's SQLite via Miniflare) with the
project's migrations and seed applied, so it exercises the same SQL that runs in
production. It covers the Whole Venue and configurable conflict rules, closures,
approval revalidation, status-change races, and double-booking prevention:
many conflicting requests fired concurrently, plus a request that is held
between its checks and its write while a competing booking completes. In every
case exactly one booking is accepted.

How double bookings are prevented: the booking row is written by a single
`INSERT ... SELECT ... WHERE NOT EXISTS (conflicting booking) AND NOT EXISTS
(closure)` statement, which D1 executes atomically, so a check can never be
overtaken by a competing write.

The `pricing`, `availability` and `londonTime` suites cover rounding rules, free
pricing, nights counted by UK calendar date, the conflict matrix, and UK
(GMT/BST) time conversion.

## Deployment (Cloudflare Pages)

Development and production use **isolated** D1 databases and R2 buckets.

1. **Cloudflare resources** (already created for this project; recreate only if
   starting a fresh account): D1 `strattonscouts-dev` / `strattonscouts-prod` and
   R2 `strattonscouts-resources-dev` / `strattonscouts-resources-prod`. The D1
   IDs in `wrangler.toml` are the real ones. To recreate:

   ```bash
   wrangler d1 create strattonscouts-dev
   wrangler d1 create strattonscouts-prod
   wrangler r2 bucket create strattonscouts-resources-dev
   wrangler r2 bucket create strattonscouts-resources-prod
   ```

   then copy the new `database_id` values into `wrangler.toml`.

2. **Apply migrations to production.** The seed data (categories, roles, the six
   resources and their illustrative prices) is migration `0002_seed.sql`, so one
   command applies everything:

   ```bash
   npm run db:migrate:remote
   ```

   Edit the seed prices in the admin portal afterwards; they are placeholders.

3. **Set production secrets** (never stored in the repo):

   ```bash
   wrangler pages secret put EMAIL_API_KEY
   wrangler pages secret put DATA_ENCRYPTION_KEY
   wrangler pages secret put BOOTSTRAP_ADMIN_TOKEN
   ```

   Set non-secret vars (`APP_BASE_URL`, `EMAIL_PROVIDER`, `EMAIL_FROM`, and for
   Office 365 `MS_TENANT_ID` and `MS_CLIENT_ID`) in the
   Pages project settings or via `wrangler.toml` `[env.production.vars]`.

4. **Deploy** by connecting the repository to a Cloudflare Pages project (build
   command `npm run build`, output directory `dist`), or manually:

   ```bash
   npm run build
   wrangler pages deploy dist
   ```

## Security notes

- Passwords are hashed with PBKDF2-SHA256 (per-user salt); session tokens are
  stored only as SHA-256 hashes.
- Session cookies are `HttpOnly`, `Secure`, `SameSite`.
- Customer contact details are encrypted at rest (AES-GCM) using
  `DATA_ENCRYPTION_KEY`.
- All inputs are validated server-side with Zod; all SQL is parameterised.
- Permission-based access control (Super Admin / Booking Admin / Viewer) is
  enforced server-side on every admin endpoint.
- Baseline security headers are applied globally in `functions/_middleware.ts`.
- Transactional emails are idempotent (a dedupe key prevents duplicates on
  retry) and failure-tolerant (a send failure never rolls back a booking).

## Sending email through Office 365

Email is sent with Microsoft Graph (`sendMail`) using an app registration, as
Cloudflare Workers cannot use SMTP. One-off setup in Microsoft 365:

1. In the [Entra admin centre](https://entra.microsoft.com), go to *App
   registrations → New registration*. Name it "Stratton Scouts bookings",
   single tenant, no redirect URI.
2. Note the *Application (client) ID* and *Directory (tenant) ID*.
3. *API permissions → Add a permission → Microsoft Graph → Application
   permissions → Mail.Send*, then *Grant admin consent*.
4. *Certificates & secrets → New client secret*. Copy the value (shown once)
   and note its expiry date; renew it before then.
5. Choose the sending mailbox, for example a shared mailbox
   `bookings@yourdomain` (shared mailboxes need no licence).
6. Recommended: limit the app to that mailbox so it cannot send as anyone
   else. In Exchange Online PowerShell, create a mail-enabled security group
   containing the mailbox, then run
   `New-ApplicationAccessPolicy -AppId <client id> -PolicyScopeGroupId <group email> -AccessRight RestrictAccess -Description "Bookings app"`.
7. Configure the site and the scheduler Worker with `EMAIL_PROVIDER=office365`,
   `EMAIL_FROM=<mailbox>`, `MS_TENANT_ID`, `MS_CLIENT_ID` (plain variables) and
   the client secret as the `EMAIL_API_KEY` secret.

Sent emails appear in the mailbox's *Sent Items*. Graph returns no message
id, so the history records Graph's request id instead.
