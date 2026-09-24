# Auth0 production setup

ArenaCore uses Auth0 as an OpenID Connect provider. Auth0 handles credentials and
provider login; ArenaCore receives a verified identity and creates its own opaque,
server-side session. Auth0 tokens are never stored in the ArenaCore database or sent
to frontend JavaScript.

## 1. Create the Auth0 application

In the Auth0 Dashboard, create an application named `ArenaCore Production` and select
**Regular Web Application**. Do not select Single Page Application: the ArenaCore API
is the confidential client and must keep the client secret on the application server.

On the application **Settings** page configure:

| Setting | Value |
| --- | --- |
| Application Login URI | `https://arena.helazzou.codes/sign-in` |
| Allowed Callback URLs | `https://api-arena.helazzou.codes/api/v1/auth/callback` |
| Allowed Web Origins | `https://arena.helazzou.codes` |
| Allowed Logout URLs | Leave empty for the current local-session logout |

The callback must match exactly: HTTPS, hostname, path, and no trailing slash.
ArenaCore currently revokes only its own session. It does not redirect through the
Auth0 logout endpoint, so an Auth0 Allowed Logout URL is not required.

Open the application's **Credentials** tab. Under **Application Authentication**, set
the authentication method to **Client Secret (Basic)**. Auth0 documents this as the
HTTP Basic method for confidential applications. New Regular Web Applications are
OIDC conformant and issue RS256 ID tokens by default, so ArenaCore does not require
access to the restricted **Advanced Settings -> OAuth** page.

Save the application, then record its **Domain**, **Client ID**, and **Client Secret**.
The issuer is `https://<AUTH0_DOMAIN>/`, including the final slash. Use the tenant
domain shown by Auth0 unless a custom Auth0 domain has already been configured and
tested. Never copy the discovery-document path into `OIDC_ISSUER`.

## 2. Choose login connections

Enable only the connections ArenaCore will present. The Auth0 database connection
provides hosted email/password registration, verification, reset, and login. Google
and GitHub can be added as social connections. Configure production social-provider
credentials before launch instead of depending on development credentials.

Do not add Auth0 roles or permissions to ArenaCore authorization. The verified Auth0
issuer and subject identify the account; the ArenaCore database remains authoritative
for `USER` and `ADMIN` roles.

## 3. Configure the application server

Generate the independent login-transaction encryption key once on a trusted machine:

```sh
openssl rand -base64 32
```

On the application instance, edit the existing root-owned file:

```sh
sudo nano /etc/arenacore/api.env
```

Set these values, substituting the Auth0 values and generated key:

```dotenv
PUBLIC_ORIGIN=https://arena.helazzou.codes
API_ORIGIN=https://api-arena.helazzou.codes
OIDC_ENABLED=true
OIDC_ISSUER=https://YOUR_AUTH0_DOMAIN/
OIDC_CLIENT_ID=YOUR_AUTH0_CLIENT_ID
OIDC_CLIENT_SECRET=YOUR_AUTH0_CLIENT_SECRET
OIDC_TRANSACTION_KEY=YOUR_BASE64_32_BYTE_KEY
OIDC_CLIENT_AUTH_METHOD=client_secret_basic
OIDC_ID_TOKEN_ALG=RS256
```

Keep `/etc/arenacore/api.env` owned by root with mode `0600`. Do not put these values
in GitHub, Vercel, the frontend repository, or any `NEXT_PUBLIC_` variable. Recreate
the API container so Docker reloads its environment file:

```sh
cd /opt/arenacore/current
sudo env "ARENACORE_API_IMAGE=$(sudo docker inspect --format '{{.Config.Image}}' arenacore-api)" \
  docker compose --env-file /etc/arenacore/compose.env \
  -p arenacore -f infra/deploy/compose.application.yml up -d --force-recreate api
```

Wait for `arenacore-api` to become healthy. A normal GitHub deployment will also
recreate it with the current environment.

## 4. Validate the live browser flow

Open a private browser window at `https://arena.helazzou.codes/sign-in` and complete
one login. Validate the following in browser developer tools:

1. The sign-in link navigates to the API, then redirects to the expected Auth0 tenant.
2. Auth0 returns only to the registered API callback.
3. The callback redirects to `https://arena.helazzou.codes/problems`.
4. `GET https://api-arena.helazzou.codes/api/v1/me` returns the signed-in user when
   sent by the frontend with credentials.
5. The session cookie is `Secure`, `HttpOnly`, `SameSite=Lax`, has `Path=/`, and has no
   `Domain` attribute.
6. Run, Submit, submission history, and local ArenaCore logout work.
7. After logout, `/me` returns `{ "user": null }`.

Also inspect the API logs without printing environment values:

```sh
sudo docker ps --filter name=arenacore-api
sudo docker logs --since 10m arenacore-api
```

If `/auth/login` returns `IDENTITY_UNAVAILABLE`, first verify that `OIDC_ISSUER` has
the exact Auth0 HTTPS domain and trailing slash, then confirm **Credentials ->
Application Authentication** is **Client Secret (Basic)** and agrees with
`OIDC_CLIENT_AUTH_METHOD=client_secret_basic`.
