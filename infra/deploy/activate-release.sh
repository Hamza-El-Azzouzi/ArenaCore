#!/usr/bin/env bash
set -euo pipefail

role="${1:-}"
revision="${2:-}"
archive="${3:-}"

if [[ "$role" != "application" && "$role" != "runner" ]]; then
  echo "DEPLOY_INVALID_ROLE" >&2
  exit 2
fi
if [[ ! "$revision" =~ ^[0-9a-f]{40}$ ]]; then
  echo "DEPLOY_INVALID_REVISION" >&2
  exit 2
fi
if [[ "$archive" != "/tmp/arenacore-${revision}.tar.gz" || ! -f "$archive" ]]; then
  echo "DEPLOY_INVALID_ARCHIVE" >&2
  exit 2
fi

root=/opt/arenacore
release="$root/releases/$revision"

sudo install -d -m 0755 "$root" "$root/releases"
sudo install -d -m 0755 -o "$(id -un)" -g "$(id -gn)" "$release"

if tar -tzf "$archive" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  echo "DEPLOY_UNSAFE_ARCHIVE" >&2
  exit 2
fi

tar -xzf "$archive" -C "$release" --no-same-owner
rm -f "$archive" /tmp/arenacore-activate-release.sh

cd "$release"

if [[ "$role" == "application" ]]; then
  sudo test -f /etc/arenacore/api.env
  sudo test -f /etc/arenacore/compose.env
  node_image="$(sudo sed -n 's/^NODE_IMAGE=//p' /etc/arenacore/compose.env)"
  if [[ "$node_image" != *@sha256:* ]]; then
    echo "DEPLOY_NODE_IMAGE_NOT_PINNED" >&2
    exit 2
  fi
  image="arenacore-api:$revision"
  sudo docker build --pull=false --build-arg "NODE_IMAGE=$node_image" -f apps/api/Dockerfile -t "$image" .
  previous_image="$(sudo docker inspect --format '{{.Config.Image}}' arenacore-api 2>/dev/null || true)"
  previous_release="$(readlink -f "$root/current" 2>/dev/null || true)"
  sudo env "ARENACORE_API_IMAGE=$image" docker compose --env-file /etc/arenacore/compose.env -p arenacore -f "$release/infra/deploy/compose.application.yml" run --rm --no-deps api npm run db:migrate
  sudo ln -sfn "$release" "$root/current"
  sudo env "ARENACORE_API_IMAGE=$image" docker compose --env-file /etc/arenacore/compose.env -p arenacore -f "$release/infra/deploy/compose.application.yml" up -d redis api
  healthy=false
  for _ in $(seq 1 30); do
    if [[ "$(sudo docker inspect --format '{{.State.Health.Status}}' arenacore-api 2>/dev/null || true)" == "healthy" ]]; then healthy=true; break; fi
    sleep 2
  done
  if [[ "$healthy" != true ]]; then
    echo "DEPLOY_API_UNHEALTHY" >&2
    if [[ -n "$previous_image" && -n "$previous_release" ]]; then
      sudo ln -sfn "$previous_release" "$root/current"
      sudo env "ARENACORE_API_IMAGE=$previous_image" docker compose --env-file /etc/arenacore/compose.env -p arenacore -f "$previous_release/infra/deploy/compose.application.yml" up -d api
    fi
    exit 1
  fi
  echo "APPLICATION_DEPLOYED $revision"
else
  npm ci
  npm run db:generate
  npm run build
  sudo test -f /etc/arenacore/runtime-images.json
  sudo -u arenacore-supervisor env \
    RUNNER_IMAGE_MANIFEST=/etc/arenacore/runtime-images.json \
    /usr/bin/node "$release/apps/runner/dist/preflight.js"
  sudo systemctl stop arenacore-supervisor.service || true
  sudo ln -sfn "$release" "$root/current"
  sudo systemctl start arenacore-supervisor.service
  sudo systemctl enable --now arenacore-janitor.timer
  sudo systemctl is-active --quiet arenacore-supervisor.service
  echo "RUNNER_DEPLOYED $revision"
fi
