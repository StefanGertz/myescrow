#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_IMAGE="${SOURCE_IMAGE:-ghcr.io/stefangertz/myescrow-api:latest}"
API_CONTAINER="${API_CONTAINER:-myescrow-api-api-1}"
WORKER_CONTAINER="${WORKER_CONTAINER:-myescrow-api-operations-worker-1}"

docker pull "$SOURCE_IMAGE" >/dev/null
available_image_id="$(docker image inspect "$SOURCE_IMAGE" --format "{{.Id}}")"
api_image_id="$(docker inspect --format "{{.Image}}" "$API_CONTAINER" 2>/dev/null || true)"
worker_image_id="$(docker inspect --format "{{.Image}}" "$WORKER_CONTAINER" 2>/dev/null || true)"

if [[ "$available_image_id" == "$api_image_id" && "$available_image_id" == "$worker_image_id" ]]; then
  echo "No new API image is available."
  exit 0
fi

immutable_digest="$(docker image inspect "$SOURCE_IMAGE" --format \
  '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}')"
if [[ -z "$immutable_digest" ]]; then
  echo "Unable to resolve an immutable digest for $SOURCE_IMAGE." >&2
  exit 1
fi

exec "$SCRIPT_DIR/deploy-release.sh" "$immutable_digest"
