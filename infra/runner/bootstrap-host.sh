#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "RUNNER_BOOTSTRAP_REQUIRES_ROOT" >&2
  exit 1
fi

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"

for binary in /usr/bin/node /usr/bin/docker /usr/bin/runsc /usr/bin/systemctl; do
  if [[ ! -x "$binary" ]]; then
    echo "RUNNER_BOOTSTRAP_MISSING_BINARY $binary" >&2
    exit 1
  fi
done

if ! getent group docker >/dev/null; then
  echo "RUNNER_BOOTSTRAP_MISSING_DOCKER_GROUP" >&2
  exit 1
fi

if ! getent group arenacore-runner >/dev/null; then
  groupadd --system arenacore-runner
fi

if ! id arenacore-supervisor >/dev/null 2>&1; then
  useradd --system \
    --gid arenacore-runner \
    --home-dir /nonexistent \
    --shell /usr/sbin/nologin \
    arenacore-supervisor
fi

if [[ "$(id -gn arenacore-supervisor)" != "arenacore-runner" ]]; then
  echo "RUNNER_BOOTSTRAP_IDENTITY_MISMATCH" >&2
  exit 1
fi

if ! id arenacore-worker >/dev/null 2>&1; then
  useradd --system \
    --gid arenacore-runner \
    --home-dir /nonexistent \
    --shell /usr/sbin/nologin \
    arenacore-worker
fi
if [[ "$(id -gn arenacore-worker)" != "arenacore-runner" ]]; then
  echo "RUNNER_BOOTSTRAP_WORKER_IDENTITY_MISMATCH" >&2
  exit 1
fi
if id -nG arenacore-worker | tr ' ' '\n' | grep -Fxq docker; then
  gpasswd --delete arenacore-worker docker >/dev/null
fi
if id -nG arenacore-worker | tr ' ' '\n' | grep -Fxq docker; then
  echo "RUNNER_BOOTSTRAP_WORKER_HAS_DOCKER_ACCESS" >&2
  exit 1
fi
usermod --append --groups docker arenacore-supervisor
if ! id -nG arenacore-supervisor | tr ' ' '\n' | grep -Fxq docker; then
  echo "RUNNER_BOOTSTRAP_DOCKER_GROUP_FAILED" >&2
  exit 1
fi

install -d -o root -g root -m 0755 /opt/arenacore /opt/arenacore/releases
install -d -o root -g arenacore-runner -m 0750 /etc/arenacore

if [[ ! -f /etc/arenacore/runtime-images.json ]]; then
  echo "RUNNER_BOOTSTRAP_MANIFEST_MISSING" >&2
  exit 1
fi
chown root:arenacore-runner /etc/arenacore/runtime-images.json
chmod 0640 /etc/arenacore/runtime-images.json

install -o root -g root -m 0644 \
  "$repo_root/infra/runner/arenacore-supervisor.service" \
  /etc/systemd/system/arenacore-supervisor.service
install -o root -g root -m 0644 \
  "$repo_root/infra/runner/arenacore-janitor.service" \
  /etc/systemd/system/arenacore-janitor.service
install -o root -g root -m 0644 \
  "$repo_root/infra/runner/arenacore-janitor.timer" \
  /etc/systemd/system/arenacore-janitor.timer
install -o root -g root -m 0644 \
  "$repo_root/infra/runner/arenacore-worker.service" \
  /etc/systemd/system/arenacore-worker.service
install -o root -g root -m 0644 \
  "$repo_root/infra/runner/arenacore-worker-check.service" \
  /etc/systemd/system/arenacore-worker-check.service

systemctl daemon-reload
systemd-analyze verify \
  /etc/systemd/system/arenacore-supervisor.service \
  /etc/systemd/system/arenacore-janitor.service \
  /etc/systemd/system/arenacore-janitor.timer \
  /etc/systemd/system/arenacore-worker.service \
  /etc/systemd/system/arenacore-worker-check.service

sudo -u arenacore-supervisor test -r /etc/arenacore/runtime-images.json
if [[ -e /etc/arenacore/worker.env ]]; then
  chown root:root /etc/arenacore/worker.env
  chmod 0600 /etc/arenacore/worker.env
fi

echo "RUNNER_BOOTSTRAP_INSTALLED_NOT_STARTED"
