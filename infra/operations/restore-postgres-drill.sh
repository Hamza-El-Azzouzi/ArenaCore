#!/usr/bin/env bash
set -euo pipefail

environment=/etc/arenacore/backup.env

fail() {
  echo "DATABASE_RESTORE_DRILL_FAILED $1" >&2
  exit 1
}

[[ "${EUID}" -eq 0 ]] || fail "ROOT_REQUIRED"
[[ "$#" -eq 3 ]] || fail "USAGE"
archive="$1"
source_database="$2"
suffix="$3"

[[ -f "$environment" && "$(stat -c '%U:%G:%a' "$environment")" == "root:root:600" ]] || fail "CONFIG"
# shellcheck source=/dev/null
source "$environment"

: "${POSTGRES_CONTAINER:?}"
: "${RESTORE_AGE_IDENTITY_FILE:?}"
[[ -f "$archive" ]] || fail "ARCHIVE_MISSING"
[[ "$source_database" =~ ^[a-zA-Z][a-zA-Z0-9_]{0,30}$ ]] || fail "DATABASE_NAME"
[[ "$suffix" =~ ^[a-z0-9]{6,20}$ ]] || fail "SUFFIX"
target_database="${source_database}_restore_${suffix}"
[[ "$target_database" != "arenacore" && "$target_database" != "watchtower" ]] || fail "PRODUCTION_TARGET"
[[ -f "$RESTORE_AGE_IDENTITY_FILE" ]] || fail "IDENTITY_MISSING"
[[ "$(stat -c '%U:%G:%a' "$RESTORE_AGE_IDENTITY_FILE")" == "root:root:600" ]] || fail "IDENTITY_PERMISSIONS"

for command in age docker flock sha256sum tar; do
  command -v "$command" >/dev/null 2>&1 || fail "MISSING_${command}"
done

exec 9>/run/lock/arenacore-database-restore.lock
flock --nonblock 9 || fail "ALREADY_RUNNING"
stage="$(mktemp -d /tmp/arenacore-restore-XXXXXX)"
created=false

cleanup() {
  rm -rf -- "$stage"
  if [[ "$created" == true ]]; then
    docker exec "$POSTGRES_CONTAINER" sh -ceu \
      'exec dropdb --if-exists -U "$POSTGRES_USER" "$1"' sh "$target_database" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

while IFS= read -r member; do
  case "$member" in
    ./manifest|./SHA256SUMS|./globals.sql.age) continue ;;
  esac
  [[ "$member" =~ ^\./[a-zA-Z][a-zA-Z0-9_]{0,62}\.dump\.age$ ]] || fail "ARCHIVE_MEMBER"
done < <(tar -tf "$archive")
tar -xf "$archive" -C "$stage" --no-same-owner --no-same-permissions
(
  cd "$stage"
  sha256sum --check --strict SHA256SUMS >/dev/null
)
[[ -f "$stage/$source_database.dump.age" ]] || fail "DATABASE_NOT_IN_ARCHIVE"

exists="$(docker exec "$POSTGRES_CONTAINER" sh -ceu \
  'exec psql -U "$POSTGRES_USER" -d postgres -Atqc "SELECT 1 FROM pg_database WHERE datname = '\''$1'\''"' \
  sh "$target_database")"
[[ -z "$exists" ]] || fail "TARGET_EXISTS"

docker exec "$POSTGRES_CONTAINER" sh -ceu \
  'exec createdb -U "$POSTGRES_USER" --template=template0 "$1"' sh "$target_database"
created=true
age --decrypt --identity "$RESTORE_AGE_IDENTITY_FILE" "$stage/$source_database.dump.age" |
  docker exec -i "$POSTGRES_CONTAINER" sh -ceu \
    'exec pg_restore --exit-on-error --no-owner --no-acl -U "$POSTGRES_USER" -d "$1"' \
    sh "$target_database"

table_count="$(docker exec "$POSTGRES_CONTAINER" sh -ceu \
  'exec psql -U "$POSTGRES_USER" -d "$1" -Atqc "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = '\''public'\''"' \
  sh "$target_database")"
[[ "$table_count" =~ ^[0-9]+$ && "$table_count" -gt 0 ]] || fail "EMPTY_RESTORE"

created=false
trap - EXIT
rm -rf -- "$stage"
echo "DATABASE_RESTORE_DRILL_PASSED $target_database"
