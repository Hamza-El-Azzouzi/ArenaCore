#!/usr/bin/env bash
set -euo pipefail

environment=/etc/arenacore/backup.env

fail() {
  echo "DATABASE_BACKUP_FAILED $1" >&2
  exit 1
}

[[ "${EUID}" -eq 0 ]] || fail "ROOT_REQUIRED"
[[ -f "$environment" ]] || fail "CONFIG_MISSING"
[[ "$(stat -c '%U:%G:%a' "$environment")" == "root:root:600" ]] || fail "CONFIG_PERMISSIONS"

# The file is root-owned and non-writable by other identities.
# shellcheck source=/dev/null
source "$environment"

: "${POSTGRES_CONTAINER:?}"
: "${BACKUP_DATABASES:?}"
: "${BACKUP_DIRECTORY:?}"
: "${BACKUP_LOCAL_RETENTION_HOURS:?}"
: "${BACKUP_AGE_RECIPIENT:?}"
: "${BACKUP_OCI_BUCKET:?}"
: "${BACKUP_OCI_PREFIX:?}"

[[ "$POSTGRES_CONTAINER" =~ ^[a-zA-Z0-9_.-]+$ ]] || fail "CONTAINER"
[[ "$BACKUP_DIRECTORY" == /var/backups/arenacore ]] || fail "DIRECTORY"
[[ "$BACKUP_LOCAL_RETENTION_HOURS" =~ ^[0-9]+$ ]] || fail "RETENTION"
(( BACKUP_LOCAL_RETENTION_HOURS >= 1 && BACKUP_LOCAL_RETENTION_HOURS <= 168 )) || fail "RETENTION"
[[ "$BACKUP_AGE_RECIPIENT" =~ ^age1[0-9a-z]+$ ]] || fail "RECIPIENT"
[[ "$BACKUP_OCI_BUCKET" =~ ^[a-zA-Z0-9_.-]+$ ]] || fail "BUCKET"
[[ "$BACKUP_OCI_PREFIX" =~ ^[a-zA-Z0-9_./-]+$ && "$BACKUP_OCI_PREFIX" != /* && "$BACKUP_OCI_PREFIX" != *".."* ]] || fail "PREFIX"

for command in age docker flock oci sha256sum tar; do
  command -v "$command" >/dev/null 2>&1 || fail "MISSING_${command}"
done

install -d -o root -g root -m 0700 "$BACKUP_DIRECTORY"
exec 9>/run/lock/arenacore-database-backup.lock
flock --nonblock 9 || fail "ALREADY_RUNNING"

docker inspect --format '{{.State.Running}}' "$POSTGRES_CONTAINER" 2>/dev/null | grep -qx true || fail "POSTGRES_UNAVAILABLE"

read -r -a databases <<<"$BACKUP_DATABASES"
(( ${#databases[@]} >= 1 && ${#databases[@]} <= 8 )) || fail "DATABASES"
for database in "${databases[@]}"; do
  [[ "$database" =~ ^[a-zA-Z][a-zA-Z0-9_]{0,62}$ ]] || fail "DATABASE_NAME"
done

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
release="$(basename "$(readlink -f /opt/arenacore/current 2>/dev/null || printf unknown)")"
stage="$(mktemp -d "$BACKUP_DIRECTORY/.stage-${timestamp}-XXXXXX")"
archive_partial="$BACKUP_DIRECTORY/.postgres-${timestamp}.tar.partial"
archive="$BACKUP_DIRECTORY/postgres-${timestamp}.tar"

cleanup() {
  rm -rf -- "$stage"
  rm -f -- "$archive_partial"
}
trap cleanup EXIT

for database in "${databases[@]}"; do
  exists="$(docker exec "$POSTGRES_CONTAINER" sh -ceu \
    'exec psql -U "$POSTGRES_USER" -d postgres -Atqc "SELECT 1 FROM pg_database WHERE datname = '\''$1'\''"' \
    sh "$database")"
  [[ "$exists" == "1" ]] || fail "DATABASE_MISSING_${database}"

  docker exec "$POSTGRES_CONTAINER" sh -ceu \
    'exec pg_dump --format=custom --compress=9 --no-owner --no-acl -U "$POSTGRES_USER" -d "$1"' \
    sh "$database" |
    age --recipient "$BACKUP_AGE_RECIPIENT" --output "$stage/$database.dump.age"
done

docker exec "$POSTGRES_CONTAINER" sh -ceu \
  'exec pg_dumpall --globals-only -U "$POSTGRES_USER"' |
  age --recipient "$BACKUP_AGE_RECIPIENT" --output "$stage/globals.sql.age"

postgres_version="$(docker exec "$POSTGRES_CONTAINER" sh -ceu 'exec postgres --version')"
{
  printf 'format=1\n'
  printf 'created_at=%s\n' "$timestamp"
  printf 'release=%s\n' "$release"
  printf 'postgres_version=%s\n' "$postgres_version"
  printf 'databases=%s\n' "$BACKUP_DATABASES"
} >"$stage/manifest"

(
  cd "$stage"
  sha256sum -- *.age >SHA256SUMS
  tar --format=posix -cf "$archive_partial" ./*.age ./manifest ./SHA256SUMS
)
chmod 0600 "$archive_partial"
mv -- "$archive_partial" "$archive"

object_name="${BACKUP_OCI_PREFIX%/}/$(basename "$archive")"
oci os object put \
  --auth instance_principal \
  --bucket-name "$BACKUP_OCI_BUCKET" \
  --name "$object_name" \
  --file "$archive" \
  --force >/dev/null
oci os object head \
  --auth instance_principal \
  --bucket-name "$BACKUP_OCI_BUCKET" \
  --name "$object_name" >/dev/null

find "$BACKUP_DIRECTORY" -maxdepth 1 -type f -name 'postgres-*.tar' \
  -mmin "+$((BACKUP_LOCAL_RETENTION_HOURS * 60))" -delete

trap - EXIT
cleanup
echo "DATABASE_BACKUP_UPLOADED"
