#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "RUNNER_METRICS_VERIFY_REQUIRES_ROOT" >&2
  exit 1
fi

if systemctl is-active --quiet arenacore-worker.service || systemctl is-enabled --quiet arenacore-worker.service; then
  echo "RUNNER_METRICS_VERIFY_WORKER_ENABLED" >&2
  exit 1
fi
systemctl is-active --quiet arenacore-supervisor.service
systemctl is-active --quiet arenacore-janitor.timer
if [[ -n "$(docker ps --all --quiet --filter label=arenacore.managed=true)" ]]; then
  echo "RUNNER_METRICS_VERIFY_BUSY" >&2
  exit 1
fi

if ! sudo -u arenacore-worker env \
  RUNNER_METRICS_ACCEPTANCE=true \
  RUNNER_SOCKET_PATH=/run/arenacore/supervisor.sock \
  /usr/bin/node /opt/arenacore/current/apps/runner/dist/metrics-acceptance.js; then
  journalctl -u arenacore-supervisor.service --since '-2 minutes' --no-pager \
    | grep 'RUNNER_METRICS_FAILED' \
    | tail -n 1 || true
  exit 1
fi

if [[ -n "$(docker ps --all --quiet --filter label=arenacore.managed=true)" ]]; then
  echo "RUNNER_METRICS_VERIFY_ORPHAN_REMAINED" >&2
  exit 1
fi
echo "RUNNER_METRICS_HOST_PASSED"
