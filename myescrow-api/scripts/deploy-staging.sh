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
AUTH_REQUIRE_EMAIL_VERIFICATION_VALUE="${AUTH_REQUIRE_EMAIL_VERIFICATION:-true}"
AUTH_DEBUG_CODES_VALUE="${AUTH_DEBUG_CODES:-false}"
EMAIL_VERIFICATION_CODE_DIGITS_VALUE="${EMAIL_VERIFICATION_CODE_DIGITS:-6}"
EMAIL_VERIFICATION_TTL_MINUTES_VALUE="${EMAIL_VERIFICATION_TTL_MINUTES:-15}"
APP_URL_VALUE="${APP_URL:-http://localhost:3000}"
if [[ -z "${EMAIL_FROM:-}" ]]; then
  EMAIL_FROM_VALUE="MyEscrow <no-reply@myescrowdemo.xyz>"
else
  EMAIL_FROM_VALUE="$EMAIL_FROM"
fi
RESEND_API_KEY_VALUE="${RESEND_API_KEY:-}"

if [[ -n "${GHCR_TOKEN:-}" ]]; then
  echo "$GHCR_TOKEN" | docker login ghcr.io -u "${GHCR_USER:-stefangertz}" --password-stdin
fi

echo "Using image: $IMAGE"

docker pull "$IMAGE"

cat <<ENV > .env.staging
PORT=$PORT_VALUE
JWT_SECRET=$JWT_SECRET
DATABASE_URL=$DATABASE_URL
AUTH_REQUIRE_EMAIL_VERIFICATION=$AUTH_REQUIRE_EMAIL_VERIFICATION_VALUE
AUTH_DEBUG_CODES=$AUTH_DEBUG_CODES_VALUE
EMAIL_VERIFICATION_CODE_DIGITS=$EMAIL_VERIFICATION_CODE_DIGITS_VALUE
EMAIL_VERIFICATION_TTL_MINUTES=$EMAIL_VERIFICATION_TTL_MINUTES_VALUE
APP_URL="$APP_URL_VALUE"
EMAIL_FROM="$EMAIL_FROM_VALUE"
RESEND_API_KEY="$RESEND_API_KEY_VALUE"
ENV

docker compose -f docker-compose.staging.yml --env-file .env.staging up -d

echo "Deployment complete. Logs: docker compose -f docker-compose.staging.yml logs -f"
