#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "WORKER_VERIFY_REQUIRES_ROOT" >&2
  exit 1
fi

environment=/etc/arenacore/worker.env
if [[ ! -f "$environment" || "$(stat -c '%U:%G:%a' "$environment")" != "root:root:600" ]]; then
  echo "WORKER_ENVIRONMENT_PERMISSIONS" >&2
  exit 1
fi
if id -nG arenacore-worker | tr ' ' '\n' | grep -Fxq docker; then
  echo "WORKER_HAS_DOCKER_GROUP" >&2
  exit 1
fi
if sudo -u arenacore-worker test -r /var/run/docker.sock; then
  echo "WORKER_CAN_READ_DOCKER_SOCKET" >&2
  exit 1
fi
if systemctl is-enabled --quiet arenacore-worker.service; then
  echo "WORKER_ALREADY_ENABLED" >&2
  exit 1
fi
if systemctl is-active --quiet arenacore-worker.service; then
  echo "WORKER_ALREADY_ACTIVE" >&2
  exit 1
fi
systemctl is-active --quiet arenacore-supervisor.service

for unit in arenacore-worker.service arenacore-worker-check.service; do
  for property in NoNewPrivileges PrivateDevices ProtectHome ProtectControlGroups ProtectKernelModules ProtectKernelTunables RestrictNamespaces RestrictSUIDSGID LockPersonality; do
    if [[ "$(systemctl show "$unit" --property="$property" --value)" != "yes" ]]; then
      echo "WORKER_HARDENING_MISMATCH $unit $property" >&2
      exit 1
    fi
  done
  if [[ -n "$(systemctl show "$unit" --property=CapabilityBoundingSet --value)" ]]; then
    echo "WORKER_CAPABILITY_BOUNDING_SET $unit" >&2
    exit 1
  fi
done

systemctl reset-failed arenacore-worker-check.service
systemctl start arenacore-worker-check.service
if [[ "$(systemctl show arenacore-worker-check.service --property=Result --value)" != "success" ]]; then
  echo "WORKER_DEPENDENCY_CHECK_FAILED" >&2
  exit 1
fi

echo "WORKER_INSTALLATION_CHECK_PASSED"
