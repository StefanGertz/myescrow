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
- `npm test` - Vitest integration tests. Uses `TEST_DATABASE_URL` or a reachable `DATABASE_URL`; otherwise it starts and removes a disposable PostgreSQL container automatically.
- `npm run test:direct` - run Vitest directly when you are managing the test database yourself.
- `npm run lint:docs` - verify `README.md` contains ASCII-only text (prevents GitHub Pages build failures).
- `npm run db:migrate` - `prisma migrate dev` against `DATABASE_URL`.
- `npm run db:push` - sync schema without migrations.
- `npm run db:generate` - regenerate the Prisma client.
- `npm run smoke` - end-to-end smoke test (signup -> overview -> milestone releases -> wallet/disputes).
- `npm run reconcile:ledger` - compare escrow ledger balances, milestone releases, and linked wallet transactions.
- `npm run evidence:reconcile-provenance` - dry-run `scripts/reconcile-evidence-provenance.ts` against legacy evidence provenance; after reviewing its output, use `npm run evidence:reconcile-provenance -- --apply` to persist only verified classifications.
- `npm run operations:run` - start the compiled recovery worker; it runs immediately and every minute until stopped.
- `npm run operations:once` - process one compiled recovery cycle and exit, for external cron platforms.
- `npm run operations:dev` - process one recovery cycle directly from TypeScript during development.
- `npm run operators:bootstrap -- admin@example.com` - grant the first administrator role to an existing verified account; refuses once any admin exists.

## API surface

Authenticated routes expect a `Bearer` token from `/api/auth/login` or `/api/auth/signup`.
Escrow creation, chat messages, funding, milestone submission, milestone approval, dispute opening/evidence/proposal/acceptance, funded cancellation requests/acceptance, cancellation-information responses, administrative cancellation actions, wallet top-up, and wallet withdrawal also require an `Idempotency-Key` header (8-200 characters). Replaying the same command and payload returns its original successful response; reusing the key for different input returns `409`.

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
| GET | `/api/dashboard/escrows/:id/messages` | Return the newest 100 append-only buyer/seller chat messages. Chat remains readable in every escrow lifecycle state. |
| POST | `/api/dashboard/escrows/:id/messages` | Send an idempotent message of up to 5,000 characters and notify the other attached party. |
| POST | `/api/dashboard/escrows/create` | Create a signed escrow proposal, persist its `full` or `milestone` funding plan as an agreement term, and atomically queue its invitation. Legacy clients may omit `fundingMode`. |
| PATCH | `/api/dashboard/escrows/:id` | Revise a pre-funding proposal, create a new agreement version, and correct/resend its invitation. |
| POST | `/api/dashboard/escrows/:id/agreement/sign` | Sign the current immutable agreement version. |
| POST | `/api/dashboard/escrows/:id/invitation/resend` | Supersede the prior delivery and queue a fresh invitation. |
| POST | `/api/dashboard/escrows/:id/invitation/extend` | Extend the current invitation deadline by 1-30 days. |
| POST | `/api/dashboard/escrows/:id/release` | Disabled compatibility route; use milestone approval to release funds. |
| POST | `/api/dashboard/escrows/:id/approve` | Mark escrow as approved. |
| POST | `/api/dashboard/escrows/:id/reject` | Reject an escrow. |
| POST | `/api/dashboard/escrows/:id/cancel` | Cancel an escrow before funding. |
| POST | `/api/dashboard/escrows/:id/fund` | Fund the complete escrow amount up front. |
| POST | `/api/dashboard/escrows/:id/milestones/:milestoneId/fund` | Add a staged deposit (`{ "amount": 1000 }`) starting at the next unsecured milestone; funds allocate across milestones in order. Omitting the amount funds that milestone's remaining shortfall for older-client compatibility. |
| POST | `/api/dashboard/escrows/:id/milestones/:milestoneId/submit` | Submit or resubmit completed work with a note and optional multipart managed proof files. |
| POST | `/api/dashboard/escrows/:id/milestones/:milestoneId/approve` | Approve the latest seller submission and release that milestone's remaining held balance. |
| POST | `/api/dashboard/escrows/:id/milestones/:milestoneId/reject` | Request a revision with a required reason saved to the review history. |
| POST | `/api/dashboard/escrows/:id/milestones/:milestoneId/dispute` | Open one active dispute and freeze that milestone's remaining held balance. |
| POST | `/api/dashboard/escrows/:id/cancellation/request` | Request mutual funded cancellation or escalate a unilateral request without moving funds. |
| POST | `/api/dashboard/cancellations/:id/accept` | Counterparty acceptance of mutual cancellation; refund only unreleased, undisputed funds. |
| POST | `/api/dashboard/cancellations/:id/information` | Either party appends an immutable response to an administrator's information request; no money moves and the case returns to the administrative queue. |
| GET | `/api/dashboard/disputes` | Active disputes. |
| GET | `/api/dashboard/disputes/:id/arbitration-report` | Complete arbitration-only report for the linked buyer or seller, including the signed agreement, chat, managed-exhibit index, legacy evidence manifest, ledger, chronology, and integrity hash. |
| POST | `/api/dashboard/disputes/:id/launch` | Mark a dispute workspace as launched. |
| POST | `/api/dashboard/disputes/:id/evidence` | Add a note or multipart managed evidence files during the evidence window. |
| POST | `/api/dashboard/disputes/:id/resolution` | Propose a complete seller/buyer allocation of the frozen amount. |
| POST | `/api/dashboard/disputes/:id/resolve` | Accept the other party's complete proposal and create linked settlement ledger entries. |
| GET | `/api/dashboard/notifications` | Dashboard notifications. |
| POST | `/api/dashboard/wallet/topup` | Increase wallet balance (`{ amount: number }`). |
| POST | `/api/dashboard/wallet/withdraw` | Withdraw from wallet (`{ amount: number }`). |
| GET | `/api/dashboard/wallet/transactions` | Recent wallet transactions (credits/debits). |
| GET | `/api/operations/health` | Support/admin health summary and active operational alerts. |
| GET | `/api/operations/jobs` | Support/admin operational job list, optionally filtered by status. |
| GET | `/api/operations/escrows/:id/audit` | Support/admin escrow audit history. |
| GET | `/api/operations/escrows/:id` | Support/admin escrow inspection record and current operator role. |
| POST | `/api/operations/cancellations/:id/actions` | Admin-only administrative gate for a unilateral cancellation. Actions may request information, close on an allowlisted procedural reason plus policy reference, or refer one eligible milestone to the formal dispute workflow while unselected funds resume. Operations does not adjudicate entitlement. The execution-only `execute_documented_full_refund` action requires an externally validated final court order or arbitration award plus authority ID, effective date, source-document SHA-256, exact authorized amount matching the full refundable balance, and administrator attestation; active dispute reserves remain held. |
| GET | `/api/operations/disputes/:id/arbitration-report` | Support/admin arbitration-only report containing the signed agreement, parties, work/evidence records, complete chat, ledger, chronology, and integrity hash. |
| GET | `/api/operations/disputes/:id/evidence` | Compatibility alias for the support/admin arbitration report. |
| GET | `/api/arbitration/disputes/:id/exhibits/:exhibitId` | Download a verified managed exhibit after arbitration is requested; limited to the linked buyer/seller or a support/admin operator. |
| POST | `/api/operations/jobs/:id/retry` | Idempotently queue a failed operational job for retry. |
| POST | `/api/operations/outbox/:id/retry` | Idempotently queue a failed invitation event for retry. |
| POST | `/api/operations/invitations/:id/extend` | Idempotently extend an active invitation deadline. |
| GET | `/api/operations/operators` | Admin-only list of support and administrator accounts. |
| POST | `/api/operations/operators/role` | Admin-only, idempotent grant, change, or revocation of operator access. |

### Managed evidence and arbitration exhibits

Multipart milestone proofs use the `proofs` field; multipart dispute evidence uses the `evidence` field. Each request accepts up to 10 files, 25 MB per file, and 100 MB total. One arbitration packet may include no more than 100 managed files totaling no more than `100,000,000` bytes across its disputed milestone and formal dispute evidence. Files are stored with a generated object key plus the original filename, media type, byte count, and SHA-256.

Arbitration exhibit downloads are available only after `arbitrationRequestedAt` is set. The API authorizes the affected buyer or seller, or a support/administrator account, confirms that the exhibit belongs to that dispute, and verifies the stored byte count and SHA-256 before returning private, non-cacheable bytes. The web client verifies the same values and the canonical report-data SHA-256 before building the PDF.

The arbitration PDF embeds every managed exhibit unchanged as an original-file attachment. Report pages contain an exhibit metadata cover only; file content is never parsed, rendered, converted, or imported into those pages. The PDF also attaches `Arbitration-Report-Data.json`, an exact-Unicode machine-readable copy of the report data. Packet generation stops if the managed evidence exceeds either cumulative limit or if the report or a file fails integrity verification. The final PDF is not digitally signed.

Managed evidence is not malware-scanned and must be treated as untrusted when extracted or opened. Use patched, isolated applications and do not enable active content merely because a file came from a packet.

Legacy evidence created by older milestone upload paths is metadata-only unless its managed-storage provenance can be verified. `scripts/reconcile-evidence-provenance.ts`, exposed as `npm run evidence:reconcile-provenance`, performs a read-only audit of legacy milestone and dispute evidence rows. After operator review, `npm run evidence:reconcile-provenance -- --apply` persists verified classifications; missing, ambiguous, size-mismatched, or hash-mismatched rows remain metadata-only. Legacy JSON evidence references likewise remain metadata-only unless they exactly match a managed file in the same arbitration.

## Testing

The Vitest suite spins up Fastify in-memory and talks to a fresh, isolated Postgres schema. Run:

```bash
npm test
```

The test runner uses `TEST_DATABASE_URL` when supplied, then tries `DATABASE_URL`. If neither points to a reachable server, it starts a disposable PostgreSQL 16 container on an available local port and removes it when the suite finishes. Docker is therefore only required when an external test database is not available.

The tests provision a fresh schema (`vitest_<uuid>`), run `prisma migrate deploy` + `prisma db seed`, and drop the schema when finished. CI continues to use its PostgreSQL service through `DATABASE_URL`; if that required service is unavailable, the test command fails instead of silently starting another database.

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

### Automated Oracle deployment

The live Oracle host runs `myescrow-autodeploy.timer`. After backend CI publishes a changed
`ghcr.io/stefangertz/myescrow-api:latest` digest, the timer invokes
`scripts/auto-deploy-staging.sh`, which delegates to `scripts/deploy-release.sh`.

Each release:

1. resolves and pins the immutable registry digest;
2. creates a compressed PostgreSQL backup under `backups/`;
3. runs `prisma migrate deploy` from the target image;
4. recreates the API and the single active operations worker;
5. verifies health, image identity, `GET /version`, route registration, and worker state;
6. restores the previous API/worker containers when verification fails.

Migrations are not automatically reversed. The backup path is printed and stored in
`.deployed-image`. Install or repair the timer on the documented live host with:

```bash
cd /home/ubuntu/myescrow-api
./scripts/install-staging-autodeploy.sh
```

For an explicit release:

```bash
./scripts/deploy-release.sh \
  ghcr.io/stefangertz/myescrow-api@sha256:<approved-digest>
```

`docker-compose.staging.yml` accepts `API_IMAGE` so both runtime services always use the same
immutable image. `GET /version` identifies the deployed Git SHA and advertised capabilities, including administrative cancellation review.

## Continuous integration

GitHub Actions workflow `.github/workflows/backend-ci.yml` (runs on push/PR) installs dependencies, executes `npm test`, builds the backend, boots it locally, runs the functional and deployment-contract smoke tests, and finishes with `npm run lint:docs`. When the branch is `main`, the workflow builds and pushes a Docker image to `ghcr.io/<owner>/myescrow-api`, waits for the Oracle deployment timer to report the same commit from `/version`, and verifies the protected milestone-funding route through the public API.
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
