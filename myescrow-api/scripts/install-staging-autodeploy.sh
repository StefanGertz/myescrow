#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ "$DEPLOY_DIR" != "/home/ubuntu/myescrow-api" ]]; then
  echo "Install this timer only from /home/ubuntu/myescrow-api on the live Oracle host." >&2
  exit 2
fi

chmod 0755 \
  "$DEPLOY_DIR/scripts/auto-deploy-staging.sh" \
  "$DEPLOY_DIR/scripts/deploy-release.sh"
sudo install -m 0644 \
  "$DEPLOY_DIR/deploy/myescrow-autodeploy.service" \
  /etc/systemd/system/myescrow-autodeploy.service
sudo install -m 0644 \
  "$DEPLOY_DIR/deploy/myescrow-autodeploy.timer" \
  /etc/systemd/system/myescrow-autodeploy.timer
sudo systemctl daemon-reload
sudo systemctl enable --now myescrow-autodeploy.timer
sudo systemctl start myescrow-autodeploy.service
sudo systemctl status --no-pager myescrow-autodeploy.timer
