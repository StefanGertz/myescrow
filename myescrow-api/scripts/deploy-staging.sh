#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL env var is required" >&2
  exit 1
fi

if [[ -z "${JWT_SECRET:-}" ]]; then
  echo "JWT_SECRET env var is required" >&2
  exit 1
fi

IMAGE="${IMAGE:-ghcr.io/stefangertz/myescrow-api:latest}"
PORT_VALUE="${PORT:-4000}"

if [[ -n "${GHCR_TOKEN:-}" ]]; then
  echo "$GHCR_TOKEN" | docker login ghcr.io -u "${GHCR_USER:-stefangertz}" --password-stdin
fi

echo "Using image: $IMAGE"

docker pull "$IMAGE"

cat <<ENV > .env.staging
PORT=$PORT_VALUE
JWT_SECRET=$JWT_SECRET
DATABASE_URL=$DATABASE_URL
ENV

docker compose -f docker-compose.staging.yml --env-file .env.staging up -d

echo "Deployment complete. Logs: docker compose -f docker-compose.staging.yml logs -f"
