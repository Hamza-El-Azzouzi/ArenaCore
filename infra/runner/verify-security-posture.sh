#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "RUNNER_SECURITY_VERIFY_REQUIRES_ROOT" >&2
  exit 1
fi

manifest=/etc/arenacore/runtime-images.json
socket=/run/arenacore/supervisor.sock
environment=/etc/arenacore/worker.env
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"

fail() {
  echo "RUNNER_SECURITY_POSTURE_FAILED $1" >&2
  exit 1
}

property_is() {
  local unit="$1" property="$2" expected="$3"
  local actual
  actual="$(systemctl show "$unit" --property="$property" --value)"
  [[ "$actual" == "$expected" ]] || fail "SYSTEMD_${unit}_${property}"
}

for binary in /usr/bin/docker /usr/bin/node /usr/bin/runsc /usr/bin/sha256sum /usr/bin/sudo /usr/bin/systemctl; do
  [[ -x "$binary" ]] || fail "MISSING_BINARY_${binary}"
done

runner_gid="$(getent group arenacore-runner | cut -d: -f3)"
[[ -n "$runner_gid" ]] || fail "RUNNER_GROUP_MISSING"
mapfile -t runner_members < <(
  {
    getent passwd | awk -F: -v gid="$runner_gid" '$4 == gid { print $1 }'
    getent group arenacore-runner | cut -d: -f4 | tr ',' '\n'
  } | sed '/^$/d' | sort -u
)
[[ "${#runner_members[@]}" -eq 2 ]] || fail "RUNNER_GROUP_MEMBERSHIP"
[[ " ${runner_members[*]} " == *" arenacore-supervisor "* ]] || fail "RUNNER_GROUP_SUPERVISOR"
[[ " ${runner_members[*]} " == *" arenacore-worker "* ]] || fail "RUNNER_GROUP_WORKER"

for identity in arenacore-supervisor arenacore-worker; do
  id "$identity" >/dev/null 2>&1 || fail "MISSING_IDENTITY_${identity}"
  [[ "$(id -gn "$identity")" == "arenacore-runner" ]] || fail "PRIMARY_GROUP_${identity}"
done

id -nG arenacore-supervisor | tr ' ' '\n' | grep -Fxq docker || fail "SUPERVISOR_DOCKER_ACCESS"
if id -nG arenacore-worker | tr ' ' '\n' | grep -Fxq docker; then
  fail "WORKER_DOCKER_GROUP"
fi
if sudo -u arenacore-worker test -r /var/run/docker.sock; then
  fail "WORKER_DOCKER_SOCKET"
fi

[[ -f "$manifest" ]] || fail "MANIFEST_MISSING"
[[ "$(stat -c '%U:%G:%a' "$manifest")" == "root:arenacore-runner:640" ]] || fail "MANIFEST_PERMISSIONS"
[[ -f "$environment" ]] || fail "WORKER_ENVIRONMENT_MISSING"
[[ "$(stat -c '%U:%G:%a' "$environment")" == "root:root:600" ]] || fail "WORKER_ENVIRONMENT_PERMISSIONS"
[[ -S "$socket" ]] || fail "SUPERVISOR_SOCKET_MISSING"
[[ "$(stat -c '%U:%G:%a' "$socket")" == "arenacore-supervisor:arenacore-runner:660" ]] || fail "SUPERVISOR_SOCKET_PERMISSIONS"

systemctl is-active --quiet arenacore-supervisor.service || fail "SUPERVISOR_INACTIVE"
systemctl is-active --quiet arenacore-janitor.timer || fail "JANITOR_TIMER_INACTIVE"
if systemctl is-active --quiet arenacore-worker.service; then
  fail "WORKER_ACTIVE"
fi
if systemctl is-enabled --quiet arenacore-worker.service; then
  fail "WORKER_ENABLED"
fi

for unit_file in \
  arenacore-supervisor.service \
  arenacore-worker.service \
  arenacore-worker-check.service \
  arenacore-janitor.service \
  arenacore-janitor.timer; do
  installed="/etc/systemd/system/$unit_file"
  [[ -f "$installed" ]] || fail "UNIT_MISSING_${unit_file}"
  [[ "$(stat -c '%U:%G:%a' "$installed")" == "root:root:644" ]] || fail "UNIT_PERMISSIONS_${unit_file}"
  cmp --silent "$repo_root/infra/runner/$unit_file" "$installed" || fail "UNIT_DRIFT_${unit_file}"
  [[ -z "$(systemctl show "$unit_file" --property=DropInPaths --value)" ]] || fail "UNIT_DROP_IN_${unit_file}"
done

property_is arenacore-supervisor.service User arenacore-supervisor
property_is arenacore-supervisor.service Group arenacore-runner
property_is arenacore-supervisor.service PrivateNetwork yes
property_is arenacore-supervisor.service RestrictAddressFamilies AF_UNIX
property_is arenacore-supervisor.service ProtectSystem strict
property_is arenacore-supervisor.service NoNewPrivileges yes
property_is arenacore-supervisor.service Restart no
[[ "$(systemctl show arenacore-supervisor.service --property=SupplementaryGroups --value)" == *docker* ]] || fail "SUPERVISOR_SUPPLEMENTARY_GROUP"
[[ -z "$(systemctl show arenacore-supervisor.service --property=CapabilityBoundingSet --value)" ]] || fail "SUPERVISOR_CAPABILITIES"

for unit in arenacore-worker.service arenacore-worker-check.service; do
  property_is "$unit" User arenacore-worker
  property_is "$unit" Group arenacore-runner
  property_is "$unit" ProtectSystem strict
  property_is "$unit" NoNewPrivileges yes
  property_is "$unit" RestrictNamespaces yes
  ip_deny="$(systemctl show "$unit" --property=IPAddressDeny --value)"
  if [[ "$ip_deny" != "any" && ( "$ip_deny" != *"0.0.0.0/0"* || "$ip_deny" != *"::/0"* ) ]]; then
    fail "WORKER_IP_DENY_${unit}"
  fi
  [[ -z "$(systemctl show "$unit" --property=CapabilityBoundingSet --value)" ]] || fail "WORKER_CAPABILITIES_${unit}"
done

docker info --format '{{json .Runtimes}}' | grep -q '"runsc"' || fail "RUNSC_NOT_REGISTERED"
if [[ -n "$(docker ps --all --quiet --filter label=arenacore.managed=true)" ]]; then
  fail "MANAGED_SANDBOX_PRESENT"
fi

mapfile -t images < <(/usr/bin/node - "$manifest" <<'NODE'
const manifest = require(process.argv[2]);
const languages = ['java', 'python', 'javascript'];
if (Object.keys(manifest).sort().join(',') !== [...languages].sort().join(',')) process.exit(1);
for (const language of languages) {
  const image = manifest[language];
  if (typeof image !== 'string' || !/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(image)) process.exit(1);
  console.log(`${language}\t${image}`);
}
NODE
) || fail "MANIFEST_INVALID"
[[ "${#images[@]}" -eq 3 ]] || fail "MANIFEST_INVALID"

for record in "${images[@]}"; do
  language="${record%%$'\t'*}"
  image="${record#*$'\t'}"
  docker image inspect "$image" >/dev/null 2>&1 || fail "IMAGE_MISSING_${language}"
  [[ "$(docker image inspect "$image" --format '{{.Config.User}}')" == "10001:10001" ]] || fail "IMAGE_USER_${language}"
done

runsc_path="$(readlink -f /usr/bin/runsc)"
[[ -f "$runsc_path" ]] || fail "RUNSC_TARGET"
runsc_mode="$(stat -c '%a' "$runsc_path")"
(( (8#$runsc_mode & 0022) == 0 )) || fail "RUNSC_WRITABLE"
[[ "$(stat -c '%U' "$runsc_path")" == "root" ]] || fail "RUNSC_OWNER"

runsc_version="$($runsc_path --version)"
runsc_version="${runsc_version%%$'\n'*}"
runsc_sha256="$(sha256sum "$runsc_path")"
runsc_sha256="${runsc_sha256%% *}"
manifest_sha256="$(sha256sum "$manifest")"
manifest_sha256="${manifest_sha256%% *}"

printf 'RUNNER_SECURITY_EVIDENCE runsc_version=%q\n' "$runsc_version"
printf 'RUNNER_SECURITY_EVIDENCE runsc_sha256=%s\n' "$runsc_sha256"
printf 'RUNNER_SECURITY_EVIDENCE manifest_sha256=%s\n' "$manifest_sha256"
echo "RUNNER_SECURITY_POSTURE_PASSED"
