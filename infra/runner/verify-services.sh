#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "RUNNER_SERVICE_VERIFY_REQUIRES_ROOT" >&2
  exit 1
fi

socket=/run/arenacore/supervisor.sock
manifest=/etc/arenacore/runtime-images.json

for binary in /usr/bin/curl /usr/bin/docker /usr/bin/node /usr/bin/systemctl; do
  if [[ ! -x "$binary" ]]; then
    echo "RUNNER_SERVICE_VERIFY_MISSING_BINARY $binary" >&2
    exit 1
  fi
done

systemctl is-active --quiet arenacore-supervisor.service
systemctl is-active --quiet arenacore-janitor.timer

for property in NoNewPrivileges PrivateDevices PrivateNetwork ProtectHome ProtectControlGroups ProtectKernelModules ProtectKernelTunables RestrictSUIDSGID LockPersonality; do
  if [[ "$(systemctl show arenacore-supervisor.service --property="$property" --value)" != "yes" ]]; then
    echo "RUNNER_SERVICE_HARDENING_MISMATCH $property" >&2
    exit 1
  fi
done
if [[ "$(systemctl show arenacore-supervisor.service --property=ProtectSystem --value)" != "strict" ]]; then
  echo "RUNNER_SERVICE_PROTECT_SYSTEM_MISMATCH" >&2
  exit 1
fi
if [[ -n "$(systemctl show arenacore-supervisor.service --property=CapabilityBoundingSet --value)" ]]; then
  echo "RUNNER_SERVICE_CAPABILITY_BOUNDING_SET" >&2
  exit 1
fi
if [[ "$(systemctl show arenacore-supervisor.service --property=RestrictAddressFamilies --value)" != "AF_UNIX" ]]; then
  echo "RUNNER_SERVICE_ADDRESS_FAMILY_MISMATCH" >&2
  exit 1
fi

if [[ -n "$(docker ps --all --quiet --filter label=arenacore.managed=true)" ]]; then
  echo "RUNNER_SERVICE_VERIFY_BUSY" >&2
  exit 1
fi

systemctl restart arenacore-supervisor.service
for _ in $(seq 1 50); do
  [[ -S "$socket" ]] && break
  sleep 0.1
done
systemctl is-active --quiet arenacore-supervisor.service
if [[ ! -S "$socket" ]]; then
  echo "RUNNER_SERVICE_SOCKET_MISSING" >&2
  exit 1
fi
if [[ "$(stat -c '%U:%G:%a' "$socket")" != "arenacore-supervisor:arenacore-runner:660" ]]; then
  echo "RUNNER_SERVICE_SOCKET_PERMISSIONS" >&2
  exit 1
fi

status="$(sudo -u arenacore-supervisor /usr/bin/curl --silent --show-error --max-time 2 --output /dev/null --write-out '%{http_code}' --unix-socket "$socket" http://localhost/health)"
if [[ "$status" != "400" ]]; then
  echo "RUNNER_SERVICE_SOCKET_PROTOCOL $status" >&2
  exit 1
fi

image="$(/usr/bin/node -e "const m=require('$manifest');if(typeof m.python!=='string')process.exit(1);process.stdout.write(m.python)")"
name="ac-$(cat /proc/sys/kernel/random/uuid)"
cleanup() { docker rm --force "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker create \
  --name "$name" \
  --pull=never \
  --runtime=runsc \
  --network=none \
  --read-only \
  --user=10001:10001 \
  --label arenacore.managed=true \
  --label arenacore.execution=00000000-0000-4000-8000-000000000001 \
  --label arenacore.attempt=1 \
  --label arenacore.deadline=1 \
  --entrypoint=/bin/sleep \
  "$image" infinity >/dev/null

systemctl start arenacore-janitor.service
if docker inspect "$name" >/dev/null 2>&1; then
  echo "RUNNER_SERVICE_JANITOR_DID_NOT_REAP" >&2
  exit 1
fi
trap - EXIT

echo "RUNNER_SERVICE_LIFECYCLE_PASSED"
