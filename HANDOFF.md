# MyEscrow Handoff

## What this repo is

This workspace contains the MyEscrow project split into:

- `myescrow-api` - Fastify + Prisma backend on PostgreSQL
- `myescrow-web` - Next.js frontend, included as a git submodule
- `index.html` - standalone artifact at repo root

## Current git state

As of 2026-07-02:

- Root repo branch: `main`
- `myescrow-web` branch: `master`
- The root repo records the current frontend submodule commit.
- Email verification uses Resend with a verified sender domain; deployed environments should set `EMAIL_FROM`, `EMAIL_REPLY_TO`, and `RESEND_API_KEY` explicitly.
- The signup and verification screens warn users that delivery can take a few minutes and suggest checking spam or junk folders.

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
2. Preserve the uncommitted change in `myescrow-web/src/app/page.tsx`.
3. Copy local env files if they exist:
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
- The main unresolved local state is the uncommitted edit in `myescrow-web/src/app/page.tsx`.
