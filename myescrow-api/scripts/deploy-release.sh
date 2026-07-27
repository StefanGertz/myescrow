#!/usr/bin/env bash
set -Eeuo pipefail

TARGET_IMAGE="${1:-${API_IMAGE:-}}"
if [[ -z "$TARGET_IMAGE" ]]; then
  echo "Usage: $0 <immutable-image-reference>" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="${DEPLOY_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
COMPOSE_FILE="${COMPOSE_FILE:-$DEPLOY_DIR/docker-compose.staging.yml}"
ENV_FILE="${ENV_FILE:-$DEPLOY_DIR/.env.staging}"
BACKUP_DIR="${BACKUP_DIR:-$DEPLOY_DIR/backups}"
STATE_FILE="${STATE_FILE:-$DEPLOY_DIR/.deployed-image}"
LOCK_FILE="${LOCK_FILE:-$DEPLOY_DIR/.deploy.lock}"
API_CONTAINER="${API_CONTAINER:-myescrow-api-api-1}"
WORKER_CONTAINER="${WORKER_CONTAINER:-myescrow-api-operations-worker-1}"

for required_file in "$COMPOSE_FILE" "$ENV_FILE"; do
  if [[ ! -f "$required_file" ]]; then
    echo "Required deployment file is missing: $required_file" >&2
    exit 2
  fi
done

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Another deployment is already running."
  exit 0
fi

cd "$DEPLOY_DIR"
mkdir -p "$BACKUP_DIR"

previous_image_id="$(docker inspect --format "{{.Image}}" "$API_CONTAINER" 2>/dev/null || true)"
services_changed=false
backup_path=""

compose() {
  API_IMAGE="$TARGET_IMAGE" docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

rollback() {
  local exit_code=$?
  trap - ERR
  if [[ "$services_changed" == "true" && -n "$previous_image_id" ]]; then
    echo "Deployment verification failed; restoring API and worker image $previous_image_id." >&2
    API_IMAGE="$previous_image_id" docker compose \
      -f "$COMPOSE_FILE" \
      --env-file "$ENV_FILE" \
      up -d --force-recreate api operations-worker || true
  fi
  if [[ -n "$backup_path" ]]; then
    echo "Database backup retained at $backup_path. Database migrations are not auto-reversed." >&2
  fi
  exit "$exit_code"
}
trap rollback ERR

echo "Pulling release image $TARGET_IMAGE."
docker pull "$TARGET_IMAGE"
resolved_image_id="$(docker image inspect "$TARGET_IMAGE" --format "{{.Id}}")"
resolved_digest="$(docker image inspect "$TARGET_IMAGE" --format \
  '{{if .RepoDigests}}{{index .RepoDigests 0}}{{else}}{{.Id}}{{end}}')"
build_sha="$(docker image inspect "$TARGET_IMAGE" --format \
  '{{index .Config.Labels "org.opencontainers.image.revision"}}')"

if [[ -z "$build_sha" || "$build_sha" == "<no value>" || "$build_sha" == "development" ]]; then
  echo "Release image is missing an immutable source revision label." >&2
  exit 1
fi

backup_path="$BACKUP_DIR/pre-deploy-${build_sha:0:12}-$(date -u +%Y%m%dT%H%M%SZ).dump"
echo "Creating database backup $backup_path."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec -T db \
  sh -lc 'pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$backup_path"
test -s "$backup_path"

echo "Applying database migrations for $build_sha."
compose run --rm --no-deps api npm run db:migrate:deploy

echo "Recreating API and operations worker."
services_changed=true
compose up -d --force-recreate api operations-worker

healthy=false
for _attempt in $(seq 1 30); do
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
    "$API_CONTAINER" 2>/dev/null || true)"
  if [[ "$health" == "healthy" ]]; then
    healthy=true
    break
  fi
  if [[ "$health" == "unhealthy" || "$health" == "exited" || "$health" == "dead" ]]; then
    break
  fi
  sleep 2
done
if [[ "$healthy" != "true" ]]; then
  echo "API did not become healthy." >&2
  compose logs --tail=100 api >&2 || true
  false
fi

api_image_id="$(docker inspect --format "{{.Image}}" "$API_CONTAINER")"
worker_image_id="$(docker inspect --format "{{.Image}}" "$WORKER_CONTAINER")"
if [[ "$api_image_id" != "$resolved_image_id" || "$worker_image_id" != "$resolved_image_id" ]]; then
  echo "API and worker are not running the requested image." >&2
  false
fi

reported_sha="$(curl -fsS http://127.0.0.1:4000/version \
  | sed -n 's/.*"buildSha":"\([^"]*\)".*/\1/p')"
if [[ "$reported_sha" != "$build_sha" ]]; then
  echo "Version endpoint reports $reported_sha instead of $build_sha." >&2
  false
fi

route_status="$(curl -sS -o /dev/null -w "%{http_code}" \
  -X POST \
  -H "Idempotency-Key: deployment-route-probe" \
  http://127.0.0.1:4000/api/dashboard/escrows/DEPLOYMENT-PROBE/milestones/1/fund)"
if [[ "$route_status" != "401" ]]; then
  echo "Milestone funding route returned $route_status instead of 401." >&2
  false
fi

if [[ "$(docker inspect --format '{{.State.Running}}' "$WORKER_CONTAINER")" != "true" ]]; then
  echo "Operations worker is not running." >&2
  false
fi

printf 'image=%s\nimage_id=%s\nbuild_sha=%s\ndeployed_at=%s\nbackup=%s\n' \
  "$resolved_digest" \
  "$resolved_image_id" \
  "$build_sha" \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "$backup_path" > "$STATE_FILE"

trap - ERR
echo "Deployment succeeded for $build_sha ($resolved_digest)."
