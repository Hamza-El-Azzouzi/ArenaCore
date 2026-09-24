#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "BACKUP_BOOTSTRAP_REQUIRES_ROOT" >&2
  exit 1
fi

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
environment=/etc/arenacore/backup.env

for command in /usr/bin/age /usr/bin/docker /usr/bin/flock /usr/bin/sha256sum /usr/bin/systemctl /usr/bin/tar; do
  if [[ ! -x "$command" ]]; then
    echo "BACKUP_BOOTSTRAP_MISSING_BINARY $command" >&2
    exit 1
  fi
done
if ! command -v oci >/dev/null 2>&1; then
  echo "BACKUP_BOOTSTRAP_MISSING_BINARY oci" >&2
  exit 1
fi
if [[ ! -f "$environment" || "$(stat -c '%U:%G:%a' "$environment")" != "root:root:600" ]]; then
  echo "BACKUP_BOOTSTRAP_CONFIG_PERMISSIONS" >&2
  exit 1
fi

install -d -o root -g root -m 0700 /var/backups/arenacore
install -o root -g root -m 0644 \
  "$repo_root/infra/operations/arenacore-database-backup.service" \
  /etc/systemd/system/arenacore-database-backup.service
install -o root -g root -m 0644 \
  "$repo_root/infra/operations/arenacore-database-backup.timer" \
  /etc/systemd/system/arenacore-database-backup.timer

systemctl daemon-reload
systemd-analyze verify \
  /etc/systemd/system/arenacore-database-backup.service \
  /etc/systemd/system/arenacore-database-backup.timer

echo "BACKUP_BOOTSTRAP_INSTALLED_NOT_STARTED"
