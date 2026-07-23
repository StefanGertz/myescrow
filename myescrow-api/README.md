# MyEscrow API ![Backend CI](https://github.com/StefanGertz/myescrow/actions/workflows/backend-ci.yml/badge.svg)

Fastify-based backend for the MyEscrow dashboard, now powered by PostgreSQL + Prisma. The original JSON fixtures remain as seed data so the frontend keeps the same demo flows.

## Prerequisites

- Node.js 20+
- npm 10+
- Docker Desktop (or any PostgreSQL 16 instance)

## Installation

```bash
cd myescrow-api
npm install
```

## Running locally

1. Start Postgres (via Docker Compose or your own instance):
   ```bash
   docker compose up -d
   ```
2. Apply the schema + seed data:
   ```bash
   npm run db:migrate
   npx prisma db seed
   ```
3. Launch the API:
   ```bash
   npm run dev
   ```

The server listens on `http://localhost:4000` (override with `PORT`). Point the Next.js frontend at it with `NEXT_PUBLIC_API_BASE_URL=http://localhost:4000` and set `NEXT_PUBLIC_USE_MOCKS=false`.

### Environment variables

Create `.env` (or copy `.env.example`):

```
PORT=4000
JWT_SECRET=dev-secret-change-me
DATABASE_URL=postgresql://myescrow:myescrow@localhost:5432/myescrow
AUTH_REQUIRE_EMAIL_VERIFICATION=true
AUTH_DEBUG_CODES=true
EMAIL_VERIFICATION_CODE_DIGITS=6
EMAIL_VERIFICATION_TTL_MINUTES=15
APP_URL=http://localhost:3000
EMAIL_FROM="MyEscrow <hello@myescrow.test>"
EMAIL_REPLY_TO=""
RESEND_API_KEY=
```

- `JWT_SECRET` secures JWTs.
- `DATABASE_URL` points Prisma at Postgres. Append `?schema=<yourname>` if you want isolated schemas per developer/test run.
- `AUTH_REQUIRE_EMAIL_VERIFICATION` toggles the verification workflow (defaults to `true`).
- `AUTH_DEBUG_CODES` surfaces verification codes in API responses/logs for local development and smoke tests. Left unset, it defaults to `true` whenever `NODE_ENV !== "production"`; set it explicitly to `false` in production environments.
- `APP_URL`, `EMAIL_FROM`, `EMAIL_REPLY_TO`, and `RESEND_API_KEY` configure email delivery. Use a verified sender domain in deployed environments, and set `EMAIL_REPLY_TO` only to a monitored inbox. When `RESEND_API_KEY` is omitted, verification codes are logged for local development and escrow invitations remain in a visible failed/retryable state.

### Email verification

Signups now return `verificationRequired: true` until the user enters a 6-digit code delivered via email. The `/api/auth/verify-email` endpoint consumes the code and returns the usual `{ token, user }` payload. `/api/auth/resend-verification` generates a new code if a user loses the previous message. Login requests before verification return HTTP 403 with guidance to verify first.

### Scripts

- `npm run dev` - Fastify + tsx watcher.
- `npm run build` / `npm start` - compile to `dist/` and run.
- `npm run lint` - type-check only.
- `npm test` - Vitest integration tests (assumes Postgres is running).
- `npm run lint:docs` - verify `README.md` contains ASCII-only text (prevents GitHub Pages build failures).
- `npm run db:migrate` - `prisma migrate dev` against `DATABASE_URL`.
- `npm run db:push` - sync schema without migrations.
- `npm run db:generate` - regenerate the Prisma client.
- `npm run smoke` - end-to-end smoke test (signup -> overview -> milestone releases -> wallet/disputes).
- `npm run reconcile:ledger` - compare escrow ledger balances, milestone releases, and linked wallet transactions.
- `npm run operations:run` - start the compiled recovery worker; it runs immediately and every minute until stopped.
- `npm run operations:once` - process one compiled recovery cycle and exit, for external cron platforms.
- `npm run operations:dev` - process one recovery cycle directly from TypeScript during development.
- `npm run operators:bootstrap -- admin@example.com` - grant the first administrator role to an existing verified account; refuses once any admin exists.

## API surface

Authenticated routes expect a `Bearer` token from `/api/auth/login` or `/api/auth/signup`.
Escrow creation, funding, milestone submission, milestone approval, dispute opening/evidence/proposal/acceptance, funded cancellation requests/acceptance, wallet top-up, and wallet withdrawal also require an `Idempotency-Key` header (8-200 characters). Replaying the same command and payload returns its original successful response; reusing the key for different input returns `409`.

| Method | Route | Description |
| --- | --- | --- |
| POST | `/api/auth/signup` | Create an account (name, email, password). |
| POST | `/api/auth/login` | Authenticate and receive a JWT. |
| POST | `/api/auth/verify-email` | Submit the 6-digit code emailed during signup. |
| POST | `/api/auth/resend-verification` | Send another verification email if the previous code expired. |
| GET | `/api/dashboard/overview` | Summary metrics and timeline. |
| GET | `/api/dashboard/escrows` | Escrows requiring review, including derived funded, held, released, refunded, and disputed balances. |
| GET | `/api/dashboard/escrows/:id/ledger` | Immutable escrow balance history for either party. |
| GET | `/api/dashboard/escrows/:id/audit` | Chronological agreement, milestone, dispute, cancellation, recovery, and money history for either party. |
| POST | `/api/dashboard/escrows/create` | Create a signed escrow proposal and atomically queue its invitation. |
| PATCH | `/api/dashboard/escrows/:id` | Revise a pre-funding proposal, create a new agreement version, and correct/resend its invitation. |
| POST | `/api/dashboard/escrows/:id/agreement/sign` | Sign the current immutable agreement version. |
| POST | `/api/dashboard/escrows/:id/invitation/resend` | Supersede the prior delivery and queue a fresh invitation. |
| POST | `/api/dashboard/escrows/:id/invitation/extend` | Extend the current invitation deadline by 1-30 days. |
| POST | `/api/dashboard/escrows/:id/release` | Disabled compatibility route; use milestone approval to release funds. |
| POST | `/api/dashboard/escrows/:id/approve` | Mark escrow as approved. |
| POST | `/api/dashboard/escrows/:id/reject` | Reject an escrow. |
| POST | `/api/dashboard/escrows/:id/cancel` | Cancel an escrow before funding. |
| POST | `/api/dashboard/escrows/:id/milestones/:milestoneId/submit` | Submit or resubmit completed work with a note and optional private evidence metadata. |
| POST | `/api/dashboard/escrows/:id/milestones/:milestoneId/approve` | Approve the latest seller submission and release that milestone's remaining held balance. |
| POST | `/api/dashboard/escrows/:id/milestones/:milestoneId/reject` | Request a revision with a required reason saved to the review history. |
| POST | `/api/dashboard/escrows/:id/milestones/:milestoneId/dispute` | Open one active dispute and freeze that milestone's remaining held balance. |
| POST | `/api/dashboard/escrows/:id/cancellation/request` | Request mutual funded cancellation or escalate a unilateral request without moving funds. |
| POST | `/api/dashboard/cancellations/:id/accept` | Counterparty acceptance of mutual cancellation; refund only unreleased, undisputed funds. |
| GET | `/api/dashboard/disputes` | Active disputes. |
| POST | `/api/dashboard/disputes/:id/launch` | Mark a dispute workspace as launched. |
| POST | `/api/dashboard/disputes/:id/evidence` | Add a note and private evidence metadata during the evidence window. |
| POST | `/api/dashboard/disputes/:id/resolution` | Propose a complete seller/buyer allocation of the frozen amount. |
| POST | `/api/dashboard/disputes/:id/resolve` | Accept the other party's complete proposal and create linked settlement ledger entries. |
| GET | `/api/dashboard/notifications` | Dashboard notifications. |
| POST | `/api/dashboard/wallet/topup` | Increase wallet balance (`{ amount: number }`). |
| POST | `/api/dashboard/wallet/withdraw` | Withdraw from wallet (`{ amount: number }`). |
| GET | `/api/dashboard/wallet/transactions` | Recent wallet transactions (credits/debits). |
| GET | `/api/operations/health` | Support/admin health summary and active operational alerts. |
| GET | `/api/operations/jobs` | Support/admin operational job list, optionally filtered by status. |
| GET | `/api/operations/escrows/:id/audit` | Support/admin escrow audit history. |
| GET | `/api/operations/disputes/:id/evidence` | Support/admin dispute evidence inspection. |
| POST | `/api/operations/jobs/:id/retry` | Idempotently queue a failed operational job for retry. |
| POST | `/api/operations/outbox/:id/retry` | Idempotently queue a failed invitation event for retry. |
| POST | `/api/operations/invitations/:id/extend` | Idempotently extend an active invitation deadline. |
| GET | `/api/operations/operators` | Admin-only list of support and administrator accounts. |
| POST | `/api/operations/operators/role` | Admin-only, idempotent grant, change, or revocation of operator access. |

## Testing

The Vitest suite spins up Fastify in-memory and talks to a dedicated Postgres schema. Before running the tests, ensure Postgres is running (e.g., `docker compose up -d`). Then:

```bash
npm test
```

The tests will provision a fresh schema (`vitest_<timestamp>`), run `prisma migrate deploy` + `prisma db seed`, and drop the schema when finished.

## Deployment

### Docker image

The repo includes a production Dockerfile and `.dockerignore`. Build and run locally:

```bash
docker build -t myescrow-api .
docker run --env-file .env -p 4000:4000 myescrow-api
```

The image contains the compiled API, operations worker, and first-admin bootstrap command.

### Staging/production checklist

1. **Database** - Provision Postgres (e.g., Supabase, RDS). Copy the connection string into DATABASE_URL.
2. **Migrations** - Run `npx prisma migrate deploy` against the remote database before booting the API or worker.
3. **Secrets** - Set PORT, JWT_SECRET, DATABASE_URL, RESEND_API_KEY, EMAIL_FROM, and APP_URL in your hosting platform.
4. **Runtime** - Run the API and compiled operations worker from the same image. `docker-compose.staging.yml` defines both services.
5. **Worker** - Keep `operations-worker` running with `OPERATIONS_INTERVAL_MS=60000`, or schedule `npm run operations:once` every minute on a cron platform.
6. **First admin** - After the verified account exists, run `npm run operators:bootstrap -- admin@example.com` once with production `DATABASE_URL`.
7. **Operators** - Use `/operations` to grant and revoke support/admin access. Never accept a role from signup input or edit roles directly in Postgres.
8. **Observability** - Alert when `/api/operations/health` reports a stale worker, and retain container logs and reconciliation alerts.

Point the frontend's `NEXT_PUBLIC_API_BASE_URL` at the deployed URL once the server is reachable.

## Continuous integration

GitHub Actions workflow `.github/workflows/backend-ci.yml` (runs on push/PR) installs dependencies, executes `npm test`, builds the backend, boots it locally, runs `npm run smoke` against `http://localhost:4000`, and finishes with `npm run lint:docs`. When the branch is `main`, the workflow also builds and pushes a Docker image to `ghcr.io/<owner>/myescrow-api`. Treat that pipeline as the gate before tagging/pushing new Docker images.
## Notes / next steps

- Update `docker-compose.yml` credentials or `DATABASE_URL` if you already have managed Postgres.
- Extend the Prisma schema as new dashboard features land (milestones, multi-user access, etc.).
- Harden auth (password policies, refresh tokens, rate limits) before promoting to production use.

## Staging deployment

1. Provision a Postgres 16 instance and capture the connection string (`DATABASE_URL`).
2. Run migrations + seed once against that database from your laptop:
   ```bash
   DATABASE_URL="postgresql://..." npm run db:migrate
   DATABASE_URL="postgresql://..." npx prisma db seed
   ```
3. On the staging host, export `DATABASE_URL`, `JWT_SECRET`, and optionally `PORT`, `GHCR_USER`, `GHCR_TOKEN`, and `OPERATIONS_INTERVAL_MS`.
4. Pull + boot the published image using the helper script:
   ```bash
   cd myescrow-api
   chmod +x scripts/deploy-staging.sh
   ./scripts/deploy-staging.sh
   ```
   The script writes `.env.staging` and runs `docker compose -f docker-compose.staging.yml up -d`.
5. Create and verify the intended administrator account, then bootstrap it from the deployed API image:
   ```bash
   docker compose -f docker-compose.staging.yml --env-file .env.staging run --rm api npm run operators:bootstrap -- admin@example.com
   ```
6. Confirm the API and worker are running and the heartbeat is current:
   ```bash
   docker compose -f docker-compose.staging.yml ps
   docker compose -f docker-compose.staging.yml logs operations-worker
   ```
7. Smoke-test the staging URL from your workstation:
   ```bash
   SMOKE_API_BASE=https://staging.example.com npm run smoke
   ```
