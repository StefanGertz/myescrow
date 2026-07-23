# MyEscrow Handoff

## What this repo is

This workspace contains the MyEscrow project split into:

- `myescrow-api` - Fastify + Prisma backend on PostgreSQL
- `myescrow-web` - Next.js frontend, included as a git submodule
- `index.html` - standalone artifact at repo root

## Current git and deployment state

As of 2026-07-22:

- Root repo branch: `main`
- `myescrow-web` branch: `master`
- Latest runtime-affecting API source and deployed image: `2280fb8` (`Add operator escrow detail access`)
- Deployed frontend commit: `6cb6777` (`Add operator escrow detail navigation`)
- The root repo records the current frontend submodule commit.
- `myescrow-api/.env.staging` is a local-only, ignored secret file created during deployment diagnosis. Never commit it. The authoritative staging environment file is on the live Oracle instance.
- Email verification uses Resend with a verified sender domain; deployed environments should set `EMAIL_FROM`, `EMAIL_REPLY_TO`, and `RESEND_API_KEY` explicitly.
- The signup and verification screens warn users that delivery can take a few minutes and suggest checking spam or junk folders.

Both production builds and test suites passed after the operations changes:

- API: 36 tests
- Frontend: 31 tests

CI note: Backend CI for source head `e3855c9` failed during GitHub Actions `Initialize containers`, before project code ran. The preceding code commit `2280fb8` passed the full Backend CI workflow, published the current GHCR image, and is running on staging. Since `e3855c9` only updates `.gitignore`, no runtime code is missing, but rerun that workflow if a green check on the source head is desired.

## Staging deployment topology

Public endpoints:

- Frontend: `https://app.myescrowdemo.xyz` on Vercel
- API: `https://staging.myescrowdemo.xyz`
- Operations dashboard: `https://app.myescrowdemo.xyz/operations`

The API hostname resolves to Oracle load balancer `staging-api-lb` at `129.153.60.204`. Its `api-backend` set routes port 4000 traffic to private IP `10.0.0.250`, which is the Oracle instance named `myescrow-arm`:

- Live API instance: `myescrow-arm`
- Private IP: `10.0.0.250`
- Public SSH IP: `40.233.124.19`
- SSH user: `ubuntu`
- Local key path: `~/.ssh/id_ed25519_oracle`
- Deployment directory: `/home/ubuntu/myescrow-api`

Do not assume the Oracle instance named `myescrow-staging` is the live backend. It has private IP `10.0.0.116` and public IP `192.18.149.34`, but the load balancer does not route public staging traffic to it. It was migrated and updated during diagnosis; its operations worker was then intentionally stopped so it cannot process jobs in parallel with the live worker.

The live Compose deployment runs three healthy services:

- `myescrow-api-db-1` (`postgres:15`)
- `myescrow-api-api-1` (`ghcr.io/stefangertz/myescrow-api:latest`)
- `myescrow-api-operations-worker-1` (same image, continuous recovery worker)

Before the July 22 operations migration, a compressed live database backup was created at:

```text
/home/ubuntu/myescrow-api/backups/pre-operations-bootstrap-20260723.dump
```

### Deployment flow

Pushing root `main` runs `.github/workflows/backend-ci.yml`. CI tests and builds the API, then publishes `ghcr.io/stefangertz/myescrow-api:latest`. Deploy the approved image on the actual load-balancer backend:

```bash
ssh -i ~/.ssh/id_ed25519_oracle ubuntu@40.233.124.19
cd /home/ubuntu/myescrow-api
docker compose -f docker-compose.staging.yml --env-file .env.staging pull api operations-worker
docker compose -f docker-compose.staging.yml --env-file .env.staging up -d api operations-worker
docker compose -f docker-compose.staging.yml --env-file .env.staging ps
```

Pushing `myescrow-web` `master` triggers Vercel. Three Vercel projects currently report deployment statuses; `app.myescrowdemo.xyz` is served by the `myescrow-demo` project. Verify the public domain rather than assuming completion when only one of the other Vercel projects succeeds.

## Operations and administrator access

The first verified staging administrator was bootstrapped successfully:

```text
stefan.gertz@gmail.com (user usr_1017, role admin)
```

The one-time command, run only on the live deployment host, is:

```bash
docker compose -f docker-compose.staging.yml --env-file .env.staging run --rm api \
  npm run operators:bootstrap -- verified-admin@example.com
```

The command requires an existing verified account and refuses to grant a second first-admin bootstrap. Additional support/admin access must be assigned through `/operations`. The final administrator cannot be demoted.

The operations page now:

- Restores the authenticated browser session before loading data and forwards the bearer token through the Next.js API proxy.
- Shows worker heartbeat, reconciliation status, alerts, failed jobs, and operator role management.
- Makes all five metric tiles keyboard- and mouse-accessible.
- Opens record-level details for failed invitation jobs, failed recovery jobs, aged escrows, approaching dispute deadlines, and safe command replays.
- Links aged escrow records to permissioned operator detail pages at `/operations/escrows/:reference`, backed by `GET /api/operations/escrows/:id`.
- Limits operations APIs to authenticated `support` or `admin` users; role management remains admin-only.

The worker heartbeat is healthy when its last successful cycle is less than two minutes old. Useful checks:

```bash
cd /home/ubuntu/myescrow-api
docker compose -f docker-compose.staging.yml --env-file .env.staging ps
docker compose -f docker-compose.staging.yml --env-file .env.staging logs --tail=100 operations-worker
```

A healthy cycle logs `operational_recovery_completed` with `failed: 0`. See `docs/operations-incident-runbook.md` for recovery and incident procedures.

## Repo shape

`myescrow-web` is a submodule:

- path: `myescrow-web`
- remote: `git@github.com:StefanGertz/MyEscrowFrontEnd.git`

That means a normal copy of only the root repo is not enough if you expect git history and clean checkout behavior. On the Mac, clone with submodules:

```bash
git clone --recurse-submodules <root-repo-url>
cd MyEscrow
git submodule update --init --recursive
```

If you transfer by AirDrop/external drive instead of cloning, make sure the `myescrow-web/.git` submodule metadata comes across intact, or re-link it by cloning fresh.

## Local setup

### Backend

Requirements:

- Node.js 20+
- npm 10+
- Docker Desktop or another PostgreSQL 16 instance

Install and run:

```bash
cd myescrow-api
npm install
docker compose up -d
npm run db:migrate
npm run db:seed
npm run dev
```

Backend default URL: `http://localhost:4000`

Suggested backend `.env` values:

```env
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

### Frontend

Requirements:

- Node.js 20+
- npm 10+

Install and run:

```bash
cd myescrow-web
npm install
npm run dev
```

Frontend default URL: `http://localhost:3000`

Useful frontend env vars in `.env.local`:

```env
NEXT_PUBLIC_API_BASE_URL=http://localhost:4000
NEXT_PUBLIC_USE_MOCKS=false
NEXT_PUBLIC_LIVE_DASHBOARD=true
```

Notes:

- Set `NEXT_PUBLIC_USE_MOCKS=true` to work against mock handlers instead of the backend.
- Leave `NEXT_PUBLIC_LIVE_DASHBOARD` unset or `false` to keep the immersive demo UI.
- Optional: `NEXT_PUBLIC_API_TOKEN=<bearer token>` for authenticated staging requests.

## Common commands

Backend:

```bash
cd myescrow-api
npm test
npm run build
npm run smoke
```

Frontend:

```bash
cd myescrow-web
npm test
npm run build
npm run lint
```

## Transfer checklist for the Mac

1. Push any commits in the root repo and in `myescrow-web` if you want the cleanest migration.
2. Confirm the root repo records the intended `myescrow-web` submodule commit.
3. Copy local development env files if they exist, but do not treat the local `.env.staging` as authoritative:
   - `myescrow-api/.env`
   - `myescrow-web/.env.local`
4. Move your SSH key and git config if you use SSH remotes:
   - `~/.ssh`
   - `~/.gitconfig`
5. Install Node 20+, npm 10+, Docker Desktop, and Git on the Mac.
6. Clone the root repo with `--recurse-submodules`, or copy the workspace and then run `git submodule update --init --recursive`.

## Recommended restart prompt

Use this prompt in the first chat on the Mac:

```text
This is the MyEscrow workspace. The root repo contains `myescrow-api` and a `myescrow-web` git submodule. Please read `HANDOFF.md`, inspect current git status in both repos, then help me continue from the current local state without overwriting uncommitted work.
```

## Known context worth preserving

- The backend is already migrated from JSON fixtures to PostgreSQL + Prisma, but seed/demo flows are still important.
- The frontend supports both mock and live API modes.
- Email verification and password reset flows exist in both API and web layers.
- The public staging load balancer targets `myescrow-arm`, not the similarly named `myescrow-staging` instance.
- The live operations worker must be unique; keep the non-routed instance's worker stopped unless the load-balancer topology is deliberately changed.
- `/operations` is the supported path for operator role changes and operational drill-downs. Do not edit roles or recovery records directly in PostgreSQL.
