# MyEscrow API

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
```

- `JWT_SECRET` secures JWTs.
- `DATABASE_URL` points Prisma at Postgres. Append `?schema=<yourname>` if you want isolated schemas per developer/test run.

### Scripts

- `npm run dev` – Fastify + tsx watcher.
- `npm run build` / `npm start` – compile to `dist/` and run.
- `npm run lint` – type-check only.
- `npm test` – Vitest integration tests (assumes Postgres is running).
- `npm run db:migrate` – `prisma migrate dev` against `DATABASE_URL`.
- `npm run db:push` – sync schema without migrations.
- `npm run db:generate` – regenerate the Prisma client.

## API surface

Authenticated routes expect a `Bearer` token from `/api/auth/login` or `/api/auth/signup`.

| Method | Route | Description |
| --- | --- | --- |
| POST | `/api/auth/signup` | Create an account (name, email, password). |
| POST | `/api/auth/login` | Authenticate and receive a JWT. |
| GET | `/api/dashboard/overview` | Summary metrics and timeline. |
| GET | `/api/dashboard/escrows` | Escrows requiring review. |
| POST | `/api/dashboard/escrows/create` | Create a new escrow draft. |
| POST | `/api/dashboard/escrows/:id/release` | Queue release for escrow `:id` (reference). |
| POST | `/api/dashboard/escrows/:id/approve` | Mark escrow as approved. |
| POST | `/api/dashboard/escrows/:id/reject` | Reject an escrow. |
| POST | `/api/dashboard/escrows/:id/cancel` | Cancel an escrow. |
| GET | `/api/dashboard/disputes` | Active disputes. |
| POST | `/api/dashboard/disputes/:id/launch` | Mark a dispute workspace as launched. |
| POST | `/api/dashboard/disputes/:id/resolve` | Resolve a dispute. |
| GET | `/api/dashboard/notifications` | Dashboard notifications. |
| POST | `/api/dashboard/wallet/topup` | Increase wallet balance (`{ amount: number }`). |
| POST | `/api/dashboard/wallet/withdraw` | Withdraw from wallet (`{ amount: number }`). |

## Testing

The Vitest suite spins up Fastify in-memory and talks to a dedicated Postgres schema. Before running the tests, ensure Postgres is running (e.g., `docker compose up -d`). Then:

```bash
npm test
```

The tests will provision a fresh schema (`vitest_<timestamp>`), run `prisma migrate deploy` + `prisma db seed`, and drop the schema when finished.

## Deployment

### Docker image

The repo now includes a production Dockerfile and .dockerignore. Build and run locally:

`
docker build -t myescrow-api .
docker run --env-file .env -p 4000:4000 myescrow-api
`

The image runs 
ode dist/server.js, so remember to build (or rely on the Dockerfile’s build stage) before pushing to a registry.

### Staging/production checklist

1. **Database** – Provision Postgres (e.g., Supabase, RDS). Copy the connection string into DATABASE_URL.
2. **Migrations** – Run 
pm run db:migrate (or 
px prisma migrate deploy) against the remote DB before booting the app.
3. **Secrets** – Set PORT, JWT_SECRET, and DATABASE_URL in your hosting platform.
4. **Runtime** – Either run the Docker image above or 
pm ci && npm run build && npm start on the host.
5. **Observability** – Add HTTPS, logging, and restart policies (systemd, PM2, Kubernetes, etc.).

Point the frontend’s NEXT_PUBLIC_API_BASE_URL at the deployed URL once the server is reachable.
## Notes / next steps

- Update `docker-compose.yml` credentials or `DATABASE_URL` if you already have managed Postgres.
- Extend the Prisma schema as new dashboard features land (milestones, multi-user access, etc.).
- Harden auth (password policies, refresh tokens, rate limits) before promoting to production use.

