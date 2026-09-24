# Encrypted PostgreSQL backup and restore

ArenaCore and Watchtower share one PostgreSQL container but use separate databases. This procedure backs up both databases and cluster globals once per day at 00:00 UTC, encrypts each PostgreSQL stream before persistent storage, uploads the package to a private OCI Object Storage bucket, and keeps only 24 hours of encrypted local packages. OCI lifecycle policy owns off-host retention.

The initial beta objectives are a recovery point of at most 24 hours and recovery within four hours. A daily schedule deliberately accepts that a failure shortly before midnight could lose almost one day of committed data. These remain objectives until a timed restore drill proves them. A successful upload is not proof of recoverability; only a restore into a new database closes the gate. If usage grows and 24 hours of possible data loss becomes unacceptable, shorten the interval or adopt continuous WAL archiving after measuring the additional storage and operational cost.

## Security model

Generate the age identity on a trusted computer, not the application VM:

```sh
age-keygen -o arenacore-backup-identity.txt
chmod 600 arenacore-backup-identity.txt
```

Store the private identity offline in at least two controlled locations. Put only the printed `age1...` recipient on the application VM. The backup VM receives write/inspect permission through an OCI instance principal and has no Object Storage download or delete permission. The encrypted streams include PostgreSQL role hashes, users, sessions, submissions, hidden tests, and audit records; treat the packages as sensitive even though they are encrypted.

The package contains individually encrypted custom-format dumps, an encrypted globals dump, a nonsecret manifest, and checksums of the encrypted files. No plaintext dump is written to disk. Local packages are mode `0600` in a root-only directory.

## OCI setup

Create a private Standard-tier bucket dedicated to database backups in the application instance's OCI region. The current script uses the instance-principal region, so a bucket with the same name in another region is not a match. Disable public access. Enable versioning if capacity permits. Add lifecycle rules for the `postgres/` prefix that retain objects for the selected recovery window and delete failed multipart uploads. With one object per day, start with a retention period that fits inside the account's 20 GB combined Always Free Object Storage allowance. Measure the first encrypted archive before choosing the final number of days: `archive size × retained days` must leave safety space for growth and versions. Test deletion rules on nonproduction objects first.

Create a dynamic group whose matching rule contains only the application instance OCID:

```text
instance.id = '<APPLICATION_INSTANCE_OCID>'
```

Grant that dynamic group bucket inspection plus object creation and inspection for only the backup bucket and `postgres/` prefix. `HeadObject` accepts `OBJECT_INSPECT`, so upload verification does not require object download or deletion access. For a bucket named `db_backup` in the root compartment and a dynamic group named `arenacore-backup-writers`, create this policy in the root compartment:

```text
Allow dynamic-group arenacore-backup-writers to inspect buckets in tenancy where target.bucket.name='db_backup'
Allow dynamic-group arenacore-backup-writers to manage objects in tenancy where all {target.bucket.name='db_backup', target.object.name='postgres/*', any {request.permission='OBJECT_CREATE', request.permission='OBJECT_INSPECT'}}
```

Substitute the actual case-sensitive dynamic-group, compartment, bucket, and prefix names. Create the policy at a compartment level that is allowed to address the bucket compartment. Do not grant object read, overwrite, or delete to the producer. OCI instance principals remove long-lived cloud credentials from the VM and record its OCID in Audit events. Follow Oracle's [instance principal guide](https://docs.oracle.com/en-us/iaas/Content/Identity/Tasks/callingservicesfrominstances.htm) and [Object Storage policy reference](https://docs.oracle.com/en-us/iaas/Content/Identity/Reference/objectstoragepolicyreference.htm); validate the exact policy in the tenancy before enabling the timer.

Install `age` and the OCI CLI on the application host. Install the CLI outside `/root` so the hardened systemd service can execute it, for example `/opt/oci-cli` with the executable linked into `/usr/local/bin`. Confirm instance-principal access without a user configuration file:

```sh
oci os ns get --auth instance_principal
```

## Host configuration

Copy `infra/operations/backup.env.example` to root-owned `/etc/arenacore/backup.env`, set mode `0600`, and replace every placeholder. `BACKUP_DATABASES` must include the actual Watchtower database name from its Compose environment and `arenacore`.

Do not add `RESTORE_AGE_IDENTITY_FILE` during normal operation. The private identity must not live permanently on the production host.

Install and test without enabling the timer:

```sh
sudo bash /opt/arenacore/current/infra/operations/bootstrap-backup.sh
sudo systemctl start arenacore-database-backup.service
sudo journalctl -u arenacore-database-backup.service -n 30 --no-pager
```

The first run succeeds only with `DATABASE_BACKUP_UPLOADED`. Confirm the new `postgres-<UTC timestamp>.tar` object exists in the private bucket, then enable scheduling:

```sh
sudo systemctl enable --now arenacore-database-backup.timer
sudo systemctl list-timers arenacore-database-backup.timer --no-pager
```

The timer runs once per day at exactly 00:00 UTC. `Persistent=true` makes systemd start a missed run after the host returns from downtime. Alert immediately if the service fails, and alert if the newest bucket object becomes older than 26 hours. The two-hour margin allows for a delayed boot or a slower dump without hiding a missed daily backup.

## Restore drill

Download an encrypted package through an administrator identity. Copy the offline age identity temporarily to the controlled restore host and add its root-owned mode-`0600` path to `/etc/arenacore/backup.env`:

```dotenv
RESTORE_AGE_IDENTITY_FILE=/etc/arenacore/backup-restore-identity.txt
```

The command accepts an archive, a source database in that archive, and a lowercase drill suffix. It constructs a new database name, refuses an existing target, verifies checksums, decrypts through a pipe, restores with `--exit-on-error`, and requires at least one public table. It never restores into `arenacore` or `watchtower`.

```sh
sudo /opt/arenacore/current/infra/operations/restore-postgres-drill.sh \
  /var/backups/arenacore/postgres-YYYYMMDDTHHMMSSZ.tar \
  arenacore \
  20260924a1
```

A pass prints `DATABASE_RESTORE_DRILL_PASSED` followed by the disposable database name. Repeat for the configured Watchtower database. Inspect schema/migration state and aggregate counts without printing user content, hidden tests, source, tokens, or password hashes. Record archive timestamp, drill times, PostgreSQL version, result, measured recovery point, and recovery time.

After retaining evidence, remove the disposable databases through the PostgreSQL container's configured superuser and remove the temporary age identity. Do not restore `globals.sql.age` into the shared production cluster during a drill; reserve it for rebuilding a new empty cluster after reviewing the roles.

## Failure handling

The timer fails closed on missing databases, invalid configuration, overlapping runs, dump/encryption/upload errors, or inability to inspect the uploaded object. It never reports success for a local-only file. Redis is excluded: PostgreSQL executions and outbox state are authoritative, while Redis queue state must be reconstructed through reconciliation after loss.

If backups fail, keep API reads available but do not enable public execution. If a restore fails, retain the encrypted package and journal, remove the partial disposable database, correct the cause, and repeat with a new suffix.
