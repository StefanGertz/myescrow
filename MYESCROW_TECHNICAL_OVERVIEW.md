# MyEscrow product and technical overview

Codebase and staging snapshot reviewed: 2026-07-27

Status: functional staging MVP

## Purpose and scope

MyEscrow is a milestone-based transaction application for buyers and sellers. The current system includes a Next.js frontend, Fastify API, PostgreSQL/Prisma data model, retryable background worker, internal financial ledger, operations console, and staging deployment.

The word “escrow” currently describes an application-level ledger and simulated wallet. There is no payment processor, bank/custody integration, KYC/AML program, regulated funds flow, or production-grade evidence object store and governance program. Treat all balances and top-ups as test data until those systems and the associated legal/compliance controls exist.

The implemented product model includes immutable agreement versions, idempotent money commands, an append-only escrow ledger, reconciliation, conditional state transitions, audit events, and recovery jobs. This document describes the product behavior and technical implementation as they exist in the reviewed snapshot.

## Codebase and runtime snapshot

| Item | Current value |
| --- | --- |
| Root repository | `git@github.com:StefanGertz/myescrow.git` |
| Root branch / last deployed API source | `main` / `0f95234447ada3b47306f59ba55a344f55320650` |
| Frontend repository | `git@github.com:StefanGertz/MyEscrowFrontEnd.git` |
| Frontend branch / commit | `master` / `d839e778e111602af14bf96bfc37ac9de041bc74` |
| Frontend relationship | Git submodule at `myescrow-web/`, recorded at `d839e778e111602af14bf96bfc37ac9de041bc74` |
| API stack | Node 20, TypeScript, Fastify 5, Prisma 5, PostgreSQL |
| Web stack | Next.js 16 App Router, React 19, React Query 5, Tailwind 4 |
| Email provider | Resend |
| Frontend hosting | Vercel |
| API hosting | Oracle VM behind an Oracle load balancer |
| API image registry | GitHub Container Registry |
| Public frontend | `https://app.myescrowdemo.xyz` |
| Public API | `https://staging.myescrowdemo.xyz` |
| Operations UI | `https://app.myescrowdemo.xyz/operations` |
| Deployed API revision | `0f95234447ada3b47306f59ba55a344f55320650` |
| Deployed API image | `ghcr.io/stefangertz/myescrow-api@sha256:efd78b63bc44b0b38ff2c6012c0573dffb67a8e0ea17f8b03acb53eea4c32139` |

On 2026-07-27, `GET https://staging.myescrowdemo.xyz/version` reported the root revision above and advertised the `milestone_funding` capability. The protected milestone-funding route returned HTTP 401 without authentication through both the API hostname and the Vercel proxy, confirming that the route is registered rather than missing. The API and sole live operations worker were healthy, all 18 Prisma migrations were current, and the first automated deployment completed with a retained pre-deploy database backup.

The frontend repository advanced to `d839e77` after the API release at root `0f95234`. Frontend CI passed, and this handoff update records the newer revision in the root submodule pointer.

## Product behavior

### Customer lifecycle

1. A person signs up as an individual or a business representative.
2. Email verification is required by default. Login returns an expiring JWT.
3. The creator chooses whether they are the buyer or seller, defines the counterparty, amount, description, funding plan, and milestones, signs, and creates an escrow. The funding plan is part of the agreement rather than a choice made after signing.
4. Creation atomically stores the escrow, agreement version, signature, invitation delivery, and outbox event. The email provider can fail without losing the escrow.
5. An existing counterparty receives the escrow immediately. A new or unverified counterparty claims pending escrows after signup/verification.
6. The counterparty can sign/approve, reject, or request agreement/milestone changes. Material changes create a new agreement version and invalidate earlier consent.
7. Both buyer and seller must sign the current locked agreement before funding.
8. The buyer funds using the signed agreement's plan. Full funding deposits the entire agreement amount; staged funding accepts any positive deposit up to the remaining agreement total.
9. Each staged deposit creates one ledger and wallet transaction. Cumulative staged funds are allocated across milestones in agreement order, so one deposit may fully secure several milestones and partially secure the next.
10. The seller submits milestone work with a note and optional managed proof files. Earlier milestones must be completed first, and the API rejects both work submissions and proof uploads unless that milestone is funded or the escrow uses full funding.
11. The buyer can approve and release the milestone, request a revision with a reason, or open a dispute.
12. A dispute freezes only the affected held amount. Parties can add managed evidence files, propose a full seller/buyer allocation, accept the other party’s proposal, or request arbitration after submitting evidence. Historic metadata-only references remain visible but the API no longer accepts new client-authored storage keys. Once arbitration is requested, support/admin operators and the affected buyer/seller can view and download the same integrity-identified arbitration report.
13. A funded cancellation can be mutual or unilateral. Mutual acceptance refunds eligible unreleased and undisputed funds. A unilateral request enters administrative cancellation review without moving money. This is an administrative gate, not arbitration: operations does not decide which party is entitled to the funds. An administrator may request more information, which either party answers in an immutable review history; close a procedurally ineligible request using an allowlisted reason code and policy reference, restoring the exact prior workflow; or refer one eligible milestone into the formal dispute process while unselected funds resume their prior workflow. Formal referral creates a milestone dispute with the normal evidence, settlement, and arbitration path. The exceptional `execute_documented_full_refund` action is execution-only: it requires an externally validated final court order or arbitration award, an authority ID, effective date, document SHA-256, exact authorized amount, and administrator attestation. The command must match the full refundable balance and excludes active dispute reserves. Every action is idempotent, audited, and notifies both parties.
14. Once both accounts are attached, the buyer and seller can exchange append-only messages on the escrow at any lifecycle state, including during a dispute and after completion or cancellation. A new message notifies the other party. The complete timestamped conversation is retained with the escrow and is included in the permissioned arbitration record; material that must be treated as formal dispute evidence still goes through the evidence flow.
15. Notifications, wallet history, escrow ledger history, chat history, and audit events provide a record of activity.

### Operational lifecycle

A separate worker:

- sends/retries invitation outbox messages;
- schedules invitation reminders and expiry;
- flags overdue funding;
- processes milestone review reminders and overdue escalation;
- sends dispute evidence reminders and closes/escalates evidence windows;
- escalates unanswered cancellation requests;
- reconciles escrow ledger, wallet transactions, and milestone state daily;
- records heartbeat and failure information.

Support/admin APIs expose worker health, failed jobs, outbox failures, aged escrows, duplicate command replays, reconciliation exceptions, dispute deadlines, arbitration requests, administrative cancellation reviews, arbitration reports containing the signed agreement, parties, evidence manifests, complete chat transcripts, ledger and chronology, audit history, and safe retry/extension commands. Administrative cancellation actions are restricted to administrators.

The web operations console implements health/alert views, administrative cancellation controls with an exact balance preview and explicit confirmation, printable/downloadable arbitration reports, failed operational-job retry, operator management, and escrow detail drill-down. Support operators may inspect administrative reviews, but only administrators see controls to request information, close a request using an allowlisted procedural reason and policy reference, refer one milestone to formal dispute, or execute an externally authorized full refund. The interface states that operations does not decide contractual entitlement. The full-refund control requires a final court order or arbitration award plus authority ID, effective date, document SHA-256, exact amount, and administrator attestation. The affected buyer and seller can access the same arbitration report from their dispute workspace. Its PDF embeds every managed exhibit unchanged as an original-file attachment, adds a metadata-only cover page for each exhibit, and attaches an exact-Unicode machine-readable `Arbitration-Report-Data.json`. Exhibit content is not parsed, rendered, converted, or imported into report pages. Exhibit retrieval is arbitration-only and limited to those parties or support/admin operators. The API and browser both verify each managed file’s stored byte count and SHA-256, while the browser also verifies the canonical report-data hash. Generation stops above 100 managed files or `100,000,000` managed-evidence bytes, or when any integrity check fails. The final PDF is not digitally signed. Some support APIs do not yet have corresponding web controls; see “Known limitations and incomplete areas.”

## System architecture

```text
Browser
  |
  | same-origin /api requests
  v
Next.js application on Vercel
  |-- mock route handlers when NEXT_PUBLIC_USE_MOCKS=true
  `-- proxy route handlers when NEXT_PUBLIC_USE_MOCKS=false
          |
          v
Fastify API on Oracle infrastructure
  |
  | Prisma
  v
PostgreSQL
  ^
  |
Operations worker ----> Resend email API
  |
  `-- outbox, deadlines, retries, reconciliation, heartbeat
```

Important boundaries:

- The browser normally calls Next.js route handlers under `/api/*`; those handlers either serve mocks or forward the request to Fastify. This avoids browser CORS issues.
- Authentication is a bearer JWT. The frontend keeps it in `sessionStorage`, restores it on refresh, and clears it at expiration or logout.
- Fastify is the domain and persistence boundary. Next.js route handlers should remain thin proxies/mocks.
- The API and worker use the same image and database but run as separate processes.
- PostgreSQL stores process state and financial records. Resend is used only for email delivery.

## Repository map

```text
myescrow/
├── .github/workflows/backend-ci.yml
├── MYESCROW_TECHNICAL_OVERVIEW.md
├── docs/
│   ├── operations-incident-runbook.md
│   ├── unhappy-workflow-remediation-plan.md
│   ├── unhappy-vs-remediated-paths.md
│   └── unhappy-workflow-diagrams.md
├── index.html
├── myescrow-api/
│   ├── prisma/
│   │   ├── schema.prisma
│   │   ├── seed.ts
│   │   └── migrations/
│   ├── scripts/
│   ├── src/
│   │   ├── config/
│   │   ├── plugins/
│   │   ├── routes/
│   │   ├── services/
│   │   ├── tests/
│   │   ├── operationsWorker.ts
│   │   └── server.ts
│   ├── Dockerfile
│   ├── docker-compose.yml
│   └── docker-compose.staging.yml
└── myescrow-web/                 # separate Git repository/submodule
    ├── .github/workflows/ci.yml
    ├── src/app/                  # pages and Next.js API handlers
    ├── src/components/
    ├── src/hooks/
    ├── src/lib/
    └── src/tests/
```

The root `index.html` and generated documents are design/presentation artifacts, not runtime dependencies.

## Backend implementation

### Entry points

- `src/server.ts`: Fastify creation, CORS, plugins, error handling, route registration, health root.
- `src/routes/auth.ts`: signup, login, verification, password reset/change.
- `src/routes/dashboard.ts`: authenticated customer API.
- `src/routes/operations.ts`: authenticated support/admin API and customer audit route.
- `src/operationsWorker.ts`: continuous or one-shot recovery worker.
- `src/operatorCli.ts`: first-admin bootstrap.

### Service responsibilities

| Service | Responsibility |
| --- | --- |
| `dashboardService.ts` | Dashboard read models and most escrow/agreement/milestone commands |
| `agreementService.ts` | Immutable agreement versions, signatures, locking, funding consent |
| `moneyIntegrityService.ts` | Internal wallet transfers, escrow ledger, balance derivation, reconciliation |
| `idempotencyService.ts` | Request hashing, replay detection, original-response replay |
| `invitationService.ts` | Transactional invitation outbox, delivery status, retry/backoff |
| `milestoneReviewService.ts` | Submissions, review history, review deadlines |
| `disputeService.ts` | Disputes, managed evidence records and legacy metadata, settlements, arbitration request, cancellations |
| `arbitrationReportService.ts` | Arbitration-only canonical reports, exhibit resolution, integrity-checked file retrieval, and party/operator authorization |
| `operationsService.ts` | Audit events, durable jobs, worker health, safe recovery commands |
| `operatorService.ts` | First admin, support/admin role management |
| `emailService.ts` | Resend payloads for verification, reset, invitation, and change requests |
| `userService.ts` | User lookup, password hashing/checking, account creation |

`dashboardService.ts` is 2,799 lines and `src/app/page.tsx` in the frontend is 5,578 lines. These are the two clearest refactoring targets.

### Data model

The authoritative schema is `myescrow-api/prisma/schema.prisma`. Main groups:

- Identity: `User`, `BusinessProfile`, `EmailVerificationToken`, `PasswordResetToken`
- Escrow: `Escrow`, `EscrowMilestone`
- Consent: `AgreementVersion`, `AgreementSignature`
- Delivery: `InvitationDelivery`, `OutboxEvent`
- Work review: `MilestoneSubmission`, `MilestoneEvidenceReference`, `MilestoneReview`
- Dispute/cancellation: `Dispute`, `DisputeEvidenceSubmission`, `DisputeEvidenceReference`, `DisputeResolutionAllocation`, `CancellationRequest`
- Communication: `EscrowMessage`
- Money: `WalletTransaction`, `EscrowLedgerEntry`, `IdempotencyRecord`
- Operations: `OperationalJob`, `OperationalWorkerState`, `ReconciliationRun`, `AuditEvent`
- Read-model support: `Notification`, `TimelineEvent`, `Sequence`

Money is stored as signed 64-bit integer cents and currently hard-coded to USD. API responses convert those values to exact JavaScript integers and reject inputs beyond JavaScript's safe exact-cent range.

Many state fields are unrestricted `String` columns rather than database/application enums. Current escrow lifecycle values include:

```text
pending_counterparty_signup
pending_approval
changes_requested
creator_signature_required
invitation_expired
funding_pending
funded
cancellation_pending
cancellation_review
dispute_resolution_pending
completed
cancelled
rejected
```

Milestone values include `not_started`, `submitted`, `revision_requested`, `released`, `disputed`, `settled`, and `cancelled`. Dispute values include `open`, `resolution_proposed`, `arbitration_requested`, `resolving`, and `resolved`.

`Escrow.fundingMode` is `full`, `milestone`, or null only for legacy proposals created before funding-plan selection became an agreement term. New creation flows require the creator to choose a plan, store it on both `Escrow` and the immutable `AgreementVersion`, and show it to the counterparty before signing. The legacy database value `milestone` represents staged funding in the product UI. Coverage is derived by allocating cumulative `fund` ledger amounts across ordered milestone amounts; individual staged deposits do not need to equal or belong to one milestone.

Because these are strings spread across services, search all transitions before changing a status name.

### Financial model and invariants

The internal wallet is a database balance on `User`; top-up and withdrawal endpoints directly change it. No external money moves.

Escrow money movements are append-only `EscrowLedgerEntry` rows with linked wallet transactions:

- `fund`
- `release`
- `refund`
- `settlement_release`
- `settlement_refund`

The core invariant is:

```text
funded = held + released + refunded
held >= 0
released + refunded <= funded
```

Active disputes are subtracted from available held funds. `applyEscrowTransfer` performs the process update, internal wallet movement, ledger record, and invariant check inside a Prisma transaction. Reconciliation compares ledger totals, milestones, and linked wallet transactions.

Full funding transfers the entire agreement amount once. Staged funding accepts an arbitrary amount up to the remaining agreement balance and allocates it FIFO across milestone amounts. A milestone may be not secured, partially secured, or fully secured. Submission and proof-storage services independently require full coverage on the backend; workflow ordering still prevents work on a later secured milestone until earlier work is resolved.

The legacy full-escrow release endpoint remains registered for compatibility but deliberately throws an error. Milestone approval is the supported release path.

### Idempotency

Consequential financial and workflow commands require an `Idempotency-Key` header of 8–200 characters. The record is unique by user and key. A matching replay returns the original JSON response; reuse with another command/payload returns HTTP 409.

The strongest coverage is on:

- escrow creation;
- funding;
- milestone submit/approve;
- dispute open/evidence/proposal/arbitration/resolve;
- escrow chat messages;
- funded cancellation request/accept and administrative review actions;
- wallet top-up/withdrawal;
- operational retry/extension/role changes.

Not every non-financial mutation uses the idempotency service. Sending the header alone does not make a route idempotent; the called service must use `idempotencyService`.

### API surface

All dashboard and operations routes require bearer authentication except auth endpoints, `GET /`, and `GET /version`. The route files are the source of truth.

Main route groups:

| Group | Examples |
| --- | --- |
| Auth | signup, login, verify/resend email, forgot/reset/change password |
| Dashboard reads | overview, escrows, business profile, disputes, notifications, wallet history |
| Agreement | create/update escrow, approve/reject, sign, request/apply changes, invitation resend/extend |
| Money | fund entire escrow, add staged funding, milestone approve, ledger history, top-up, withdraw |
| Work review | submit/resubmit milestone, request revision, apply milestone changes |
| Communication | list and send escrow-scoped buyer/seller messages |
| Dispute/cancellation | open dispute, managed or metadata-only evidence, proposal, arbitration, resolve, request/accept cancellation |
| Operations | health, jobs, retry, audit, administrative cancellation information/procedural-close/milestone-referral/documented-full-refund actions, arbitration reports and authorized exhibit downloads, invitation recovery, operator roles |

The API README route table is useful but is not exhaustive relative to the registered routes.

### Worker behavior

Run continuously:

```bash
npm run operations:run
```

Run one cycle:

```bash
npm run operations:once
```

The staging Compose file runs the continuous worker every minute. It stores jobs, claims them conditionally, retries with backoff, recovers locks older than ten minutes, and updates the `primary` worker heartbeat. A healthy deployment should show a successful heartbeat within two minutes.

See `docs/operations-incident-runbook.md` before manually intervening. Do not repair ledger, job, outbox, or operator state by editing PostgreSQL.

## Frontend implementation

### Main application modes

The same codebase contains three meaningful combinations:

| `NEXT_PUBLIC_USE_MOCKS` | `NEXT_PUBLIC_LIVE_DASHBOARD` | Result |
| --- | --- | --- |
| `true` or unset | `false` or unset | Immersive demo UI with Next.js mock API handlers |
| `false` | `false` or unset | Immersive UI with live Fastify data |
| `false` | `true` | Smaller `LiveDashboard` with live Fastify data |

`src/app/page.tsx` is the immersive application and contains most screens and transaction workflows in one file. `src/components/LiveDashboard.tsx` is the smaller live layout.

### API flow

- React Query hooks live in `src/hooks/useAuthApi.ts` and `src/hooks/useDashboardData.ts`.
- `src/lib/apiClient.ts` adds the runtime bearer token.
- Browser requests to `/api/*` remain same-origin.
- Every Next.js route handler either returns mock data or uses `src/lib/serverProxy.ts` to forward method, headers, and body to Fastify.
- Mock fixtures and many shared response types live in `src/lib/mockDashboard.ts`.

The immersive transaction screen uses `stagedFundingSupported` in live escrow responses as the arbitrary-amount compatibility signal. Escrow-list responses similarly advertise `fundingPlanSelectionSupported` before the creation wizard allows a funding plan to become an agreement term. During a frontend/backend rollout gap, the affected control is disabled and shows `Backend update pending`; this prevents a newer UI from collecting terms an older API would silently discard. These guards complement—but do not replace—the deployment verification described below.

`NEXT_PUBLIC_API_BASE_URL` is read by server route code but is named as a public browser variable, so its value is part of public build-time configuration.

### Authentication

- `AuthProvider` owns the current user/token.
- Sessions are kept in `sessionStorage`, not durable `localStorage`.
- The token is cleared on expiration, logout, or browser-session end.
- Default API JWT lifetime is eight hours (`AUTH_SESSION_TTL_SECONDS`).
- There are no refresh tokens, server-side revocation list, device/session management, or forced invalidation after password change.
- Customer and operations login use the same underlying JWT/account system; authorization is enforced by API role checks.

### Mock credentials

Mock mode accepts:

```text
Email: scott@example.com
Password: Escrow123!
```

The Prisma seed creates verified `scott@example.com` and `nora@example.com` records from `data/store.json`. This overview does not include a plaintext live/seed password; local access can be established through the reset flow or fresh accounts.

## Local setup

### Clone correctly

The frontend is a submodule:

```bash
git clone --recurse-submodules git@github.com:StefanGertz/myescrow.git
cd myescrow
git submodule update --init --recursive
```

Commit frontend work in `myescrow-web` first, push it, then commit the updated submodule pointer in the root repo.

### Prerequisites

- Node.js 20+
- npm 10+
- Docker Desktop or another reachable PostgreSQL instance
- Git/SSH access to both repositories

Versions used for this review:

```text
Node v20.20.2
npm 10.8.2
Docker 29.6.1
```

### API

```bash
cd myescrow-api
npm ci
cp .env.example .env
docker compose up -d db
npm run db:migrate
npm run db:seed
npm run dev
```

The API defaults to `http://localhost:4000`.

Important: `npm run db:seed` deletes and recreates application data in the configured database. Verify `DATABASE_URL` before running it. Never seed staging or production.

Recommended local `.env`:

```dotenv
PORT=4000
JWT_SECRET=replace-with-a-long-random-local-secret
AUTH_SESSION_TTL_SECONDS=28800
DATABASE_URL=postgresql://myescrow:myescrow@localhost:5432/myescrow
AUTH_REQUIRE_EMAIL_VERIFICATION=true
AUTH_DEBUG_CODES=true
EMAIL_VERIFICATION_CODE_DIGITS=6
EMAIL_VERIFICATION_TTL_MINUTES=15
PASSWORD_RESET_CODE_DIGITS=6
PASSWORD_RESET_TTL_MINUTES=15
APP_URL=http://localhost:3000
EMAIL_FROM="MyEscrow <hello@myescrow.test>"
EMAIL_REPLY_TO=""
RESEND_API_KEY=
```

With no Resend key, verification/reset codes are logged locally, but escrow invitation delivery enters a visible failed/retryable state.

### Frontend against mocks

```bash
cd myescrow-web
npm ci
printf 'NEXT_PUBLIC_USE_MOCKS=true\nNEXT_PUBLIC_LIVE_DASHBOARD=false\n' > .env.local
npm run dev
```

### Frontend against the local API

Create `myescrow-web/.env.local`:

```dotenv
NEXT_PUBLIC_API_BASE_URL=http://localhost:4000
NEXT_PUBLIC_USE_MOCKS=false
NEXT_PUBLIC_LIVE_DASHBOARD=false
```

Then:

```bash
cd myescrow-web
npm run dev
```

The frontend defaults to `http://localhost:3000`.

Do not use `NEXT_PUBLIC_API_TOKEN` in a shared or deployed environment. It is a build-exposed fallback intended for temporary development.

## Quality gates

Latest local verification:

| Project | Command | Result |
| --- | --- | --- |
| API | `npm test` | 2 files, 42 tests passed |
| API | `npm run build` | passed |
| API | `npm run lint` | TypeScript no-emit check passed |
| Frontend | `npm test` | 16 files, 54 tests passed |
| Frontend | `npm run build` | passed; 32 pages/routes generated |
| Frontend | `npm run lint` | passed |

Backend tests create an isolated PostgreSQL schema, deploy all 19 migrations, seed it, run the suite, and drop the schema. If no test/database URL is reachable, the runner can start a disposable PostgreSQL 16 container.

There is no measured coverage threshold, browser end-to-end suite, payment-provider contract suite, load test, penetration test, accessibility audit, or migration rollback test.

CI:

- Root `.github/workflows/backend-ci.yml` runs migrations, seed, backend tests, build, functional smoke, deployment-contract smoke, and docs encoding checks. On `main`, it publishes mutable `latest`, `v1`, and immutable commit-SHA GHCR tags.
- The live Oracle host checks the approved `latest` digest with `myescrow-autodeploy.timer`. A changed digest invokes `scripts/deploy-release.sh`, which pins the immutable digest, backs up PostgreSQL, applies migrations, recreates the API and sole live worker, verifies health/version/route registration, and restores the previous containers if verification fails.
- Backend CI waits for `/version` to report the pushed commit SHA and then runs a non-mutating public deployment-contract smoke test. A release is not green merely because the image was published.
- Frontend `.github/workflows/ci.yml` runs lint, tests, and build on `master`/`main` and pull requests.
- Vercel deployment is triggered from the frontend repository, while API image publication is triggered from the root repository. A root submodule update does not by itself replace the frontend deployment.

Backend CI passed for `0f95234`, including the automated public staging verification. Frontend CI passed for both the rollout guard at `310cbbd` and the current frontend head at `d839e77`.

## Staging and deployment

Current documented topology:

```text
app.myescrowdemo.xyz
  -> Vercel project serving myescrow-web

staging.myescrowdemo.xyz
  -> Oracle load balancer
  -> Oracle VM
  -> Docker Compose:
       PostgreSQL
       Fastify API
       operations worker
```

The API image is `ghcr.io/stefangertz/myescrow-api`. The live host uses `myescrow-api/docker-compose.staging.yml`, a host-only `.env.staging`, and the `myescrow-autodeploy.timer` systemd timer.

The ignored `myescrow-api/.env.staging` on this workstation is incomplete and is not the staging source of truth.

The public API path is:

```text
Oracle load balancer staging-api-lb (129.153.60.204)
  -> api-backend on port 4000
  -> myescrow-arm (private 10.0.0.250, public SSH 40.233.124.19)
  -> /home/ubuntu/myescrow-api
```

SSH uses user `ubuntu` and local key `~/.ssh/id_ed25519_oracle`. The similarly named `myescrow-staging` VM is not the public backend. Its worker must remain stopped unless the load-balancer topology is deliberately changed; running a second worker against the same database can process jobs twice.

The live Compose project runs exactly one PostgreSQL service, one API service, and one operations worker. The first automated release recorded:

```text
Build: 0f95234447ada3b47306f59ba55a344f55320650
Image: ghcr.io/stefangertz/myescrow-api@sha256:efd78b63bc44b0b38ff2c6012c0573dffb67a8e0ea17f8b03acb53eea4c32139
Backup: /home/ubuntu/myescrow-api/backups/pre-deploy-0f95234447ad-20260727T123455Z.dump
```

### Deployment mechanics

The deployment flow is:

1. Backend CI tests and builds the API.
2. A successful `main` build publishes GHCR tags for `latest`, `v1`, and the commit SHA.
3. The Oracle timer detects the new registry digest and calls `scripts/deploy-release.sh`.
4. The release script creates a compressed database backup and runs `prisma migrate deploy` from the target image.
5. The API and operations worker are recreated from the same immutable digest.
6. The script verifies container health, image identity, `/version`, milestone-funding route registration, and the worker process. Failed verification restores the previous containers; database backups are retained and migrations are never automatically reversed.
7. Backend CI waits for the public API to report the expected SHA and runs `npm run smoke:deployment`.

`GET /version` returns the deployed source SHA and advertised API capabilities, including `staged_funding_amounts` and `agreement_funding_plan` on compatible releases. The immersive frontend uses corresponding capability fields in customer responses to keep staged funding and agreement-plan selection disabled during a backend/frontend rollout gap.

Useful live checks:

```bash
ssh -i ~/.ssh/id_ed25519_oracle ubuntu@40.233.124.19
cd /home/ubuntu/myescrow-api
systemctl status --no-pager myescrow-autodeploy.timer
cat .deployed-image
docker compose -f docker-compose.staging.yml --env-file .env.staging ps
docker compose -f docker-compose.staging.yml --env-file .env.staging logs --tail=100 operations-worker
curl -fsS https://staging.myescrowdemo.xyz/version
```

For a deliberate manual release, use an approved immutable digest:

```bash
./scripts/deploy-release.sh \
  ghcr.io/stefangertz/myescrow-api@sha256:<approved-digest>
```

Do not return to a bare `docker compose pull && up` deployment; that bypasses the backup, migration, revision, route, and rollback checks. Ordinary API images deploy automatically. Changes to the deployment scripts, Compose file, or systemd units do not self-install from the image: copy those reviewed files to `/home/ubuntu/myescrow-api` and rerun `scripts/install-staging-autodeploy.sh` before relying on new deployment-agent behavior.

### 2026-07-27 milestone-funding incident and resolution

The buyer-facing milestone-funding dialog originally appeared to do nothing because the Vercel frontend called `POST /api/dashboard/escrows/:id/milestones/:milestoneId/fund`, while the live Oracle API was still an older image and returned `Route ... not found`. Backend CI had successfully built and published the corrected image, but image publication did not deploy it to the VM.

Root commit `3c71555` added and tested server-side funding enforcement for both milestone submissions and proof uploads. That release used milestone-linked deposits; the current staged model instead requires cumulative FIFO allocation to fully cover the milestone. Frontend commit `310cbbd` added the first rollout compatibility guard. Root commit `0f95234` then added immutable build metadata, `GET /version`, deployment smoke tests, guarded backup/migration/deploy/rollback scripts, and the Oracle auto-deploy timer.

The first automated run deployed `0f95234`; CI did not turn green until the public version and protected route checks passed. Future diagnosis should begin with `/version`, the Backend CI “Wait for staging deployment” step, `.deployed-image`, and the timer status rather than assuming that a successful image build reached the VM.

### 2026-08-02 large-transaction creation incident and resolution

A `$25,000,000.00` escrow failed during creation because its `2,500,000,000`-cent total exceeded PostgreSQL's signed 32-bit `INTEGER` maximum. The API logged the Prisma persistence error but returned only the generic `Internal server error` response. Migration `20260802190000_expand_money_columns` changes every monetary cents column—not only the creation total—to `BIGINT`, and API/idempotency serialization converts those database values back to exact JSON numbers. Integration coverage creates, signs, tops up, and fully funds the `$25,000,000.00` case so later wallet, ledger, dispute, and refund operations do not reintroduce the same ceiling.

## Known limitations and incomplete areas

### Funds, evidence, and dispute authority

- Wallet top-up and withdrawal update database balances only. No payment provider, bank, custody account, webhook flow, settlement state, reversal, or chargeback integration exists.
- KYC/KYB, AML/sanctions screening, transaction monitoring, regulated custody, and jurisdiction-specific compliance are outside the current system.
- Managed milestone and dispute evidence uses filesystem storage with generated object keys, file metadata, and SHA-256 values. Arbitration downloads authorize the linked parties or support/admin operators, verify file size and hash on the API and in the browser, verify the canonical report-data hash in the browser, and embed managed originals unchanged as PDF attachments behind metadata-only cover pages. The packet also carries exact-Unicode machine-readable report data. Exhibit content is never imported into report pages. Legacy JSON references remain metadata-only unless they match a managed file in the same arbitration. The packet is limited to 100 managed files and `100,000,000` managed-evidence bytes, and the final PDF is not digitally signed. Evidence is not malware-scanned and must be treated as untrusted when extracted or opened. There is still no production private object-store policy, retention workflow, or encryption/key policy.
- Arbitration creates an `arbitration_requested` state and operations alert. It does not implement internal staff adjudication or let staff author an allocation. The administrative full-refund command only executes an externally validated final court order or arbitration award with the required authority metadata and attestation.
- Currency is effectively fixed to USD even though currency appears on ledger and agreement records.

### Security and authentication

- `JWT_SECRET` falls back to `dev-secret-change-me` when absent, including under a production environment.
- Verification and password-reset codes are written to application logs by `emailService.ts`.
- Login, signup, verification, resend, forgot/reset password, invitation, and financial endpoints have no rate limits, account lockout, or bot/abuse controls.
- Fastify CORS is configured with `origin: true`.
- Browser authentication uses a bearer JWT in `sessionStorage`. There are no refresh tokens, server-side revocation, device/session management, or operator MFA.
- Password changes do not revoke already issued JWTs.
- No penetration test, dependency security gate, formal threat model, or authorization-matrix suite is represented in the repository.

### Functional and client/API inconsistencies

- `LiveDashboard` submits escrow creation without the PNG signature required by the Fastify schema. The frontend hook marks `signatureDataUrl` optional, so the mismatch is not caught by TypeScript.
- Frontend mutation hooks create a new UUID when a mutation is invoked. A separate user retry after an uncertain response uses a new idempotency key rather than the original command key.
- The operations API supports outbox retry, invitation extension, arbitration report inspection, and audit history, while the web operations interface exposes only part of that functionality.
- The immersive dashboard and `LiveDashboard` are different product surfaces with different feature coverage.
- Some Next.js mock handlers implement behavior that is intentionally simpler than the live API.
- The API README route table is incomplete relative to registered Fastify routes.

### Code structure, testing, and operations

- `dashboardService.ts` is 2,799 lines and owns both read models and many commands. The immersive `src/app/page.tsx` is 5,578 lines.
- Frontend response types are partly derived from mock models rather than a shared/generated API contract.
- Lifecycle, milestone, delivery, and dispute statuses are unrestricted strings spread across services.
- Automated coverage consists primarily of API integration tests and frontend component/utility tests. There is no browser end-to-end suite, coverage threshold, load test, accessibility audit, payment-provider contract suite, or migration rollback test.
- Dashboard freshness relies partly on polling.
- Escrow chat uses three-second polling rather than WebSockets and currently has no attachments, edit/delete controls, read receipts, typing/presence signals, moderation controls, or configurable retention/purge workflow. Messages are currently retained in the primary database with restrictive escrow and sender foreign keys and are available to support/admin reviewers only through a linked dispute’s arbitration record.
- Observability is limited to structured application/container logs, stored worker heartbeat, operations health queries, and database reconciliation records; there is no tracing or error-tracking integration.
- Local and test Compose use PostgreSQL 16, while staging Compose declares PostgreSQL 15.
- `.env.example` contains the unused `DATA_STORE_PATH` variable.
- `docs/unhappy-workflow-diagrams.md` describes the earlier unsafe workflow, while the remediation documents describe later implementation phases.

## Product behavior not yet defined

The code makes temporary assumptions in areas where final product behavior has not been defined:

- Supported countries, currencies, transaction sizes, prohibited activities, and user types
- Whether MyEscrow is a custodian, marketplace, agent, or UI over a licensed provider
- Invitation, funding, review, evidence, cancellation, and dispute deadlines
- Buyer non-response policy (current behavior is hold and escalate, never auto-release)
- When milestones may proceed out of order
- Who can cancel at each lifecycle state
- Who adjudicates arbitration and how allocations are authorized
- Refund, reversal, chargeback, fee, tax, and FX behavior
- Evidence/file retention and privacy rights
- Chat retention, moderation, abuse reporting, and when chat content can be admitted into a dispute record
- Notification channels and legally effective notice
- Support service levels and escalation ownership

## Useful commands

API:

```bash
cd myescrow-api
npm run dev
npm test
npm run lint
npm run build
npm run smoke
npm run db:migrate
npm run db:migrate:deploy
npm run db:seed
npm run reconcile:ledger
npm run evidence:reconcile-provenance
npm run operations:dev
npm run operations:run
```

`myescrow-api/scripts/reconcile-evidence-provenance.ts` is exposed as `npm run evidence:reconcile-provenance`. It performs a read-only dry run for legacy evidence created by older milestone upload paths and audits both milestone and dispute evidence rows. After an operator reviews the output, `npm run evidence:reconcile-provenance -- --apply` persists only verified classifications; missing, ambiguous, size-mismatched, or hash-mismatched rows remain metadata-only.

Frontend:

```bash
cd myescrow-web
npm run dev
npm test
npm run lint
npm run build
```

Repository/submodule:

```bash
git status --short
git submodule status
git -C myescrow-web status --short
git -C myescrow-web log -1 --oneline
```

## Related technical documents

- `myescrow-api/README.md`: API setup, scripts, route summary, testing, and deployment notes
- `myescrow-web/README.md`: frontend setup, runtime modes, proxy behavior, and authentication
- `docs/operations-incident-runbook.md`: worker behavior, support roles, and incident procedures
- `docs/unhappy-workflow-remediation-plan.md`: rationale behind the ledger, agreement, evidence, dispute, and recovery models
- `docs/unhappy-vs-remediated-paths.md`: comparison of the earlier and current failure-handling paths
- `docs/arbitration-report.md`: arbitration report contents, access boundaries, integrity model, and exhibit handling limits
