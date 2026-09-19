# Backend continuous deployment

Every push to `main` runs the database, Redis, type, test and dependency checks in
`.github/workflows/backend.yml`. Only the exact commit that passes those checks is
packaged and sent over authenticated SSH. Application deployment builds an ARM64 API
image from a pinned Node base, applies forward migrations, switches the `current`
symlink and replaces the API container. A failed build or migration leaves the prior
release active. A failed readiness check restores the previous image when one exists;
migrations still require backward-compatible releases because database rollback is not automatic.

The frontend is deployed independently by Vercel. `PUBLIC_ORIGIN` identifies that exact
browser origin; `API_ORIGIN` identifies the Caddy endpoint. Credentialed CORS, CSRF and
Socket.IO accept only the configured frontend origin.

## One-time application-host bootstrap

The application host already runs PostgreSQL and Caddy in the `watchtower` Compose
project. Create an `arenacore` database and login in that PostgreSQL cluster, but do not
reuse Watchtower's database login. ArenaCore adds only an API container and Redis.

Create the deployment directories:

```sh
sudo install -d -m 0755 /opt/arenacore/releases
sudo install -d -m 0700 -o root -g root /etc/arenacore
```

Pull the approved Node 24 base once, then record its immutable digest:

```sh
sudo docker pull node:24-bookworm-slim
sudo docker inspect --format '{{index .RepoDigests 0}}' node:24-bookworm-slim
```

Create root-owned `/etc/arenacore/compose.env` with mode `0600`:

```dotenv
APP_PRIVATE_IP=10.0.0.51
CADDY_NETWORK=watchtower_backend
NODE_IMAGE=node@sha256:REPLACE_WITH_RECORDED_DIGEST
ARENACORE_REDIS_PASSWORD=REPLACE_WITH_64_HEX_CHARACTERS
```

Create root-owned `/etc/arenacore/api.env` with mode `0600`. Use independently generated
hex passwords so their URL form is unambiguous:

```dotenv
NODE_ENV=production
HOST=0.0.0.0
PORT=3001
PUBLIC_ORIGIN=https://arena.helazzou.codes
API_ORIGIN=https://api-arena.helazzou.codes
DATABASE_URL=postgresql://arenacore:REPLACE_DATABASE_PASSWORD@postgres:5432/arenacore
REDIS_URL=redis://:REPLACE_REDIS_PASSWORD@redis:6379/0
EXECUTIONS_ENABLED=false
PIPELINE_ENABLED=false
REALTIME_ENABLED=false
OIDC_ENABLED=false
TRUST_PROXY_CIDRS=172.18.0.0/16
```

Complete the remaining values from `.env.example`. Keep execution disabled until the
runner gates pass. The API has no published host port; Caddy reaches the `arenacore-api`
alias through `watchtower_backend`.

Before activating the runner, add `10.0.0.51:5432:5432` to the existing PostgreSQL
service and permit ports 5432 and 6379 in the Oracle network security group from
`10.0.0.164/32` only. Recreating PostgreSQL causes a short Watchtower database outage,
so schedule that change after the API deployment is verified.

The SSH deployment account needs noninteractive permission for the narrowly used
`docker`, `install`, `ln`, and runner preflight commands. The default
Oracle Ubuntu account has broad passwordless sudo; replace it with a dedicated deploy
account and a constrained sudoers policy before public launch.

## GitHub environments and secrets

Create a protected GitHub environment named `production` and add:

| Secret | Value |
| --- | --- |
| `APP_SSH_HOST` | Application VM public DNS name or IP |
| `APP_SSH_PORT` | SSH port, normally `22` |
| `APP_SSH_USER` | Deployment account |
| `APP_SSH_PRIVATE_KEY` | Dedicated deployment private key |
| `APP_SSH_HOST_KEY` | Complete verified `known_hosts` line for the application VM |

Use a deployment key created specifically for GitHub Actions, not a personal daily-use
SSH key. Obtain the server ED25519 fingerprint from the VM console and compare it with
the host key before saving `APP_SSH_HOST_KEY`; do not trust an unverified `ssh-keyscan`
result.

After the host is bootstrapped and the environment secrets exist, every successful push
to `main` deploys the tested commit automatically. Pull requests, scheduled audits and
manual verification runs never deploy.

Create a second protected environment named `production-runner` with corresponding
`RUNNER_SSH_HOST`, `RUNNER_SSH_PORT`, `RUNNER_SSH_USER`, `RUNNER_SSH_PRIVATE_KEY`, and
`RUNNER_SSH_HOST_KEY` secrets. Runner deployment is additionally disabled unless the
repository variable `DEPLOY_RUNNER` is exactly `true`.

Keep `DEPLOY_RUNNER` disabled until immutable runtime images exist and the dedicated
host isolation suite passes. When enabled, a runner release must pass preflight before
the active symlink changes. The API service never receives Docker access.

For this deployment use `PUBLIC_ORIGIN=https://arena.helazzou.codes` and
`API_ORIGIN=https://api-arena.helazzou.codes`. These origins share a registrable domain,
so secure host-only SameSite cookies remain available to credentialed API and Socket.IO
requests. Both transports allow only the exact configured frontend origin.
