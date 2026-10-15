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
   | `EMAIL_PROVIDER`       | `console` (logs emails) or a real provider e.g. `resend`       |
   | `EMAIL_API_KEY`        | Provider API key (**secret**)                                  |
   | `EMAIL_FROM`           | From address for outbound mail                                 |
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
   Camping), illustrative per-category prices, and the mandatory conflict matrix
   (self-conflicts plus the Whole Venue relationships).

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

   Set non-secret vars (`APP_BASE_URL`, `EMAIL_PROVIDER`, `EMAIL_FROM`) in the
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
