#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "RUNNER_CRASH_VERIFY_REQUIRES_ROOT" >&2
  exit 1
fi

socket=/run/arenacore/supervisor.sock
execution_id="$(cat /proc/sys/kernel/random/uuid)"
case_id="$(cat /proc/sys/kernel/random/uuid)"
request_file="/run/arenacore-crash-${execution_id}.json"
response_file="/run/arenacore-crash-${execution_id}.response"
curl_pid=''
container_id=''
supervisor_disrupted=false
request_started_ms=''

now_ms() {
  /usr/bin/node -e 'process.stdout.write(String(Date.now()))'
}

restore() {
  local exit_code=$?
  if [[ -n "$curl_pid" ]]; then
    kill "$curl_pid" >/dev/null 2>&1 || true
    wait "$curl_pid" >/dev/null 2>&1 || true
  fi
  [[ -n "$container_id" ]] && docker rm --force "$container_id" >/dev/null 2>&1 || true
  rm -f "$request_file" "$response_file"
  if [[ "$supervisor_disrupted" == true ]]; then
    systemctl reset-failed arenacore-supervisor.service >/dev/null 2>&1 || true
    if ! systemctl is-active --quiet arenacore-supervisor.service; then
      systemctl start arenacore-supervisor.service >/dev/null 2>&1 || true
    fi
  fi
  exit "$exit_code"
}
trap restore EXIT

for binary in /usr/bin/curl /usr/bin/docker /usr/bin/node /usr/bin/systemctl; do
  if [[ ! -x "$binary" ]]; then
    echo "RUNNER_CRASH_VERIFY_MISSING_BINARY $binary" >&2
    exit 1
  fi
done

if systemctl is-active --quiet arenacore-worker.service || systemctl is-enabled --quiet arenacore-worker.service; then
  echo "RUNNER_CRASH_VERIFY_WORKER_ENABLED" >&2
  exit 1
fi
systemctl is-active --quiet arenacore-supervisor.service
systemctl is-active --quiet arenacore-janitor.timer
if [[ "$(systemctl show arenacore-supervisor.service --property=Restart --value)" != "no" ]]; then
  echo "RUNNER_CRASH_VERIFY_RESTART_POLICY" >&2
  exit 1
fi
active_release="$(readlink -f /opt/arenacore/current)"
main_pid="$(systemctl show arenacore-supervisor.service --property=MainPID --value)"
if [[ ! "$main_pid" =~ ^[1-9][0-9]+$ ]] || [[ "$(readlink -f "/proc/${main_pid}/cwd")" != "$active_release" ]]; then
  echo "RUNNER_CRASH_VERIFY_RELEASE_MISMATCH" >&2
  exit 1
fi
if [[ -n "$(docker ps --all --quiet --filter label=arenacore.managed=true)" ]]; then
  echo "RUNNER_CRASH_VERIFY_BUSY" >&2
  exit 1
fi

/usr/bin/node -e "const fs=require('node:fs');fs.writeFileSync(process.argv[1],JSON.stringify({executionId:process.argv[2],attempt:1,language:'python',sourceCode:'import time\\ntime.sleep(60)\\n',cases:[{id:process.argv[3],input:''}],timeMs:10000,memoryMiB:128}))" "$request_file" "$execution_id" "$case_id"
chown root:arenacore-runner "$request_file"
chmod 0640 "$request_file"

policy_total_ms="$(/usr/bin/node -e "const {CAPS}=require('/opt/arenacore/current/packages/runtime-policy/dist/index.js');if(!Number.isSafeInteger(CAPS.totalMs)||CAPS.totalMs<1000||CAPS.totalMs>300000)process.exit(1);process.stdout.write(String(CAPS.totalMs))")"
request_started_ms="$(now_ms)"
sudo -u arenacore-worker /usr/bin/curl \
  --silent --show-error --max-time 45 \
  --unix-socket "$socket" \
  --header 'content-type: application/json' \
  --data-binary "@$request_file" \
  http://localhost/execute >"$response_file" 2>/dev/null &
curl_pid=$!

for _ in $(seq 1 100); do
  container_id="$(docker ps --quiet --filter label=arenacore.managed=true --filter "label=arenacore.execution=$execution_id")"
  [[ -n "$container_id" ]] && break
  sleep 0.1
done
if [[ ! "$container_id" =~ ^[a-f0-9]{12,64}$ ]]; then
  echo "RUNNER_CRASH_VERIFY_SANDBOX_NOT_STARTED" >&2
  exit 1
fi
if [[ "$(docker inspect --format '{{.HostConfig.Runtime}}:{{.State.Running}}' "$container_id")" != "runsc:true" ]]; then
  echo "RUNNER_CRASH_VERIFY_SANDBOX_POLICY" >&2
  exit 1
fi

supervisor_disrupted=true
systemctl kill --kill-who=main --signal=SIGKILL arenacore-supervisor.service
for _ in $(seq 1 50); do
  systemctl is-active --quiet arenacore-supervisor.service || break
  sleep 0.1
done
if systemctl is-active --quiet arenacore-supervisor.service; then
  echo "RUNNER_CRASH_VERIFY_SUPERVISOR_SURVIVED" >&2
  exit 1
fi
sleep 1
if systemctl is-active --quiet arenacore-supervisor.service || [[ "$(systemctl show arenacore-supervisor.service --property=MainPID --value)" != "0" ]]; then
  echo "RUNNER_CRASH_VERIFY_UNEXPECTED_RESTART" >&2
  exit 1
fi
if ! docker inspect "$container_id" >/dev/null 2>&1; then
  echo "RUNNER_CRASH_VERIFY_ORPHAN_NOT_OBSERVED" >&2
  exit 1
fi

deadline="$(docker inspect --format '{{index .Config.Labels "arenacore.deadline"}}' "$container_id")"
observed_ms="$(now_ms)"
if [[ ! "$deadline" =~ ^[0-9]+$ ]]; then
  echo "RUNNER_CRASH_VERIFY_DEADLINE_FORMAT" >&2
  exit 1
fi
deadline_offset_ms=$(( deadline - request_started_ms ))
if (( deadline_offset_ms <= 0 || deadline_offset_ms > policy_total_ms + 5000 )); then
  echo "RUNNER_CRASH_VERIFY_DEADLINE_BOUND offset_ms=${deadline_offset_ms} policy_ms=${policy_total_ms}" >&2
  exit 1
fi
remaining_ms=$(( deadline - observed_ms ))
if (( remaining_ms > 0 )); then
  wait_seconds=$(( (remaining_ms + 999) / 1000 + 1 ))
  sleep "$wait_seconds"
fi

systemctl start arenacore-janitor.service
if docker inspect "$container_id" >/dev/null 2>&1; then
  echo "RUNNER_CRASH_VERIFY_JANITOR_DID_NOT_REAP" >&2
  exit 1
fi
if systemctl is-active --quiet arenacore-supervisor.service; then
  echo "RUNNER_CRASH_VERIFY_SUPERVISOR_RESTARTED_DURING_REAP" >&2
  exit 1
fi
container_id=''

systemctl reset-failed arenacore-supervisor.service
systemctl start arenacore-supervisor.service
for _ in $(seq 1 50); do
  [[ -S "$socket" ]] && break
  sleep 0.1
done
systemctl is-active --quiet arenacore-supervisor.service
if [[ ! -S "$socket" ]]; then
  echo "RUNNER_CRASH_VERIFY_SOCKET_MISSING" >&2
  exit 1
fi
status="$(sudo -u arenacore-worker /usr/bin/curl --silent --show-error --max-time 2 --output /dev/null --write-out '%{http_code}' --unix-socket "$socket" http://localhost/health)"
if [[ "$status" != "400" ]]; then
  echo "RUNNER_CRASH_VERIFY_SOCKET_PROTOCOL $status" >&2
  exit 1
fi
if [[ -n "$(docker ps --all --quiet --filter label=arenacore.managed=true)" ]]; then
  echo "RUNNER_CRASH_VERIFY_ORPHAN_REMAINED" >&2
  exit 1
fi
supervisor_disrupted=false

kill "$curl_pid" >/dev/null 2>&1 || true
wait "$curl_pid" >/dev/null 2>&1 || true
curl_pid=''
rm -f "$request_file" "$response_file"
trap - EXIT
echo "RUNNER_CRASH_RECOVERY_PASSED"
