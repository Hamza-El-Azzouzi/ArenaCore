# ArenaCore authentication setup

ArenaCore supports native email/password accounts, direct Google OpenID Connect,
direct GitHub OAuth, and the existing generic OIDC/Auth0 connection. Every method
ends in the same opaque, server-side ArenaCore session. Provider tokens are used only
to verify identity and are never stored.

## Application server configuration

Generate a stable transaction key on a trusted machine:

```sh
openssl rand -base64 32
```

Add it to the root-owned `/etc/arenacore/api.env`, enable native accounts, and keep
the file owned by root with mode `0600`:

```dotenv
PASSWORD_AUTH_ENABLED=true
AUTH_TRANSACTION_KEY=REPLACE_WITH_BASE64_32_BYTE_KEY
```

The deployment applies the `Credential` migration before replacing the API container.
Native registration collects a unique public username, display name, email, and
password directly on the ArenaCore sign-up page. Passwords must contain 12 to 128
characters. ArenaCore normalizes usernames and email addresses to lowercase and
stores only salted scrypt password hashes.

## Google button

Create a Google OAuth web client. Register these exact values:

- Authorized JavaScript origin: `https://arena.helazzou.codes`
- Authorized redirect URI: `https://api-arena.helazzou.codes/api/v1/auth/callback`

Then add the confidential values only to `/etc/arenacore/api.env`:

```dotenv
GOOGLE_AUTH_ENABLED=true
GOOGLE_CLIENT_ID=REPLACE_WITH_GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET=REPLACE_WITH_GOOGLE_CLIENT_SECRET
```

In Google Cloud, complete the OAuth consent-screen branding and either publish the
application or add every person who will sign in as a test user. The redirect URI
must match character-for-character, including `https`, hostname, path, and the
absence of a trailing slash. Google documents these requirements in its
[OpenID Connect guide](https://developers.google.com/identity/openid-connect/openid-connect).

## GitHub button

In GitHub, open **Settings → Developer settings → OAuth Apps**, register an OAuth
application, and use:

- Homepage URL: `https://arena.helazzou.codes`
- Authorization callback URL: `https://api-arena.helazzou.codes/api/v1/auth/callback`

Add its credentials only to `/etc/arenacore/api.env`:

```dotenv
GITHUB_AUTH_ENABLED=true
GITHUB_CLIENT_ID=REPLACE_WITH_GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET=REPLACE_WITH_GITHUB_CLIENT_SECRET
```

ArenaCore requests no GitHub scopes. It uses PKCE and the OAuth state/browser binding,
reads the authenticated user's stable numeric GitHub ID, and discards the access token.

## Existing Auth0 connection

`OIDC_ENABLED` and the `OIDC_*` settings remain supported. The old `/auth/login`
route defaults to that connection for compatibility. The frontend's Google and GitHub
buttons explicitly choose the direct providers and do not visit Auth0 Universal Login.
The provider transaction also carries an encrypted, validated internal return path,
so users return to the ArenaCore page that requested authentication. Provider denial
returns to the ArenaCore sign-in form with a generic error and never exposes provider
diagnostics.

## Activation and verification

After editing the environment, deploy or recreate the API container. Check these flows
in a private browser window:

1. Create a native account and confirm `/api/v1/me` returns that user.
2. Sign out and sign in again with the native password.
3. Use each enabled social button and confirm its provider returns to the exact API callback.
4. Confirm the final session cookie is `Secure`, `HttpOnly`, `SameSite=Lax`, has
   `Path=/`, and has no `Domain` attribute.
5. Confirm logout makes `/api/v1/me` return `{ "user": null }`.

Google and GitHub still show their own account-selection or consent screen. That
redirect is required for the provider to authenticate the user; Auth0 is not involved.

## Provider troubleshooting

The public, non-sensitive readiness endpoint shows what the deployed API has enabled:

```sh
curl -fsS https://api-arena.helazzou.codes/api/v1/auth/providers
```

For Google, it must return `"google":true`. If it does not, confirm that
`GOOGLE_AUTH_ENABLED=true`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and a stable
`AUTH_TRANSACTION_KEY` are present in `/etc/arenacore/api.env`, then deploy the API
again. Do not paste any of these values into the frontend, GitHub, or chat.

If Google itself displays `redirect_uri_mismatch`, correct the redirect URI in Google
Cloud rather than changing the application URL. If Google blocks a user before the
callback, add that user to the OAuth consent-screen test-user list or publish the
consent screen.
