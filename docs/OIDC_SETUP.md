# OIDC sign-in setup

The backend implements Authorization Code + PKCE login for a confidential OIDC web client. No provider password form or development authentication bypass is present. It remains disabled until you register a client and configure the backend.

## Provider registration

Use an HTTPS issuer supporting OIDC discovery, Authorization Code, PKCE S256, a JWKS endpoint and RS256 (default) or ES256 signed ID tokens. Register a confidential web client with `client_secret_basic` (default) or `client_secret_post` token endpoint authentication. Set an exact callback URI:

```text
https://your-arena-domain.example/api/v1/auth/callback
```

For local development the app callback can be `http://localhost:3000/api/v1/auth/callback`, with `/api/v1` proxied to the API. The issuer itself always requires HTTPS. During API-only development you may set `PUBLIC_ORIGIN=http://localhost:3001` and register its callback; the final `/problems` UI route requires the frontend to be imported later.

The API requests only `openid profile`. Email is not used for account linking. The configured issuer and verified subject together identify the account; token/profile roles never grant administrator access.

## Environment

Copy the settings from `.env.example` into your private root `.env` or managed deployment secrets. Set:

- `OIDC_ENABLED=true`
- `OIDC_ISSUER`: exact provider issuer, including any required realm/path; do not use the discovery document URL.
- `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`: the confidential client registration.
- `OIDC_TRANSACTION_KEY`: a random 32-byte key encoded in standard base64. Generate with `openssl rand -base64 32` and store privately. Never commit it. All API instances must use the same key; changing it invalidates in-flight login attempts.
- `OIDC_CLIENT_AUTH_METHOD`: the method registered with the provider.
- `OIDC_ID_TOKEN_ALG`: the registered signed ID-token algorithm (`RS256` or `ES256`).
- `PUBLIC_ORIGIN`: exact browser origin, without trailing slash. Production requires HTTPS.

Optional controls: `SESSION_TTL_SECONDS` (default 8 hours, maximum 24 hours), per-IP/global login caps, and `TRUST_PROXY_CIDRS`. Leave proxy trust empty unless a known reverse proxy is configured. Use only its precise IP/CIDRs, restrict direct API access, and configure the proxy to overwrite forwarded headers. Trust-all, hop-count settings and `/0` CIDRs are rejected. API instances share database-backed login counters.

Apply migrations, generate Prisma, build and restart the API after changing configuration:

```sh
npm run db:generate
npm run db:migrate
npm run build
npm run start:api
```

## Browser lifecycle

1. Navigate to `/api/v1/auth/login` on the app origin. The API creates a five-minute encrypted proof and HttpOnly SameSite=Lax browser-binding cookie, then redirects to the provider with state, nonce and S256 PKCE.
2. The provider redirects back to `/api/v1/auth/callback`. The API validates query shape, browser binding and expiry, atomically consumes state, and exchanges the authorization code. It validates issuer/audience/expiry/nonce and explicitly enables ID-token JWS signature validation using provider JWKS.
3. The API creates or updates the issuer/subject account, rotates any prior browser session, and creates a new session. It stores session and CSRF hashes rather than their plaintext tokens. Provider access/refresh/ID tokens are not stored or exposed. The browser receives a new HttpOnly cookie and redirects to `/problems`.
4. Call `GET /api/v1/me` with cookie credentials to get the current public profile and stable CSRF token. Include `X-CSRF-Token` and the correct browser Origin on protected POST requests.
5. `POST /api/v1/auth/logout` revokes the app session, records the audit action and clears the cookie. This is local app logout; it does not sign the user out of the identity provider or implement back-channel logout.

Production cookies have `__Host-` names, Secure, HttpOnly, SameSite=Lax, Path=/ and no Domain attribute. Session lifetime is absolute, without rolling extension. At most ten active sessions per account are retained; older active sessions are revoked when that limit is reached. Expired sessions for an account are removed during sign-in. Database role assignment owns RBAC; use `SessionGuard` followed by `RolesGuard` and `RequireRoles` for future admin endpoints. No problem-authoring admin endpoint exists yet.

A browser has one active login attempt. Restarting login invalidates that browser's older pending attempt. Replayed, denied or invalid-token callbacks cannot be retried with the same state; start login again. After logout the provider may silently authenticate a fresh login based on its own session.

## Validation and limits

Automated integration checks use the actual OIDC client, RSA-signed JWTs and JWKS responses through a controlled test transport, plus a real HTTP API and PostgreSQL. They verify claim/signature rejection, state/cookie binding, replay races, proof tampering, session rotation, secure cookie attributes, logout, provider outages and rate caps. They do not exercise a third-party provider account or the frontend browser UI.

Before live deployment, register the real provider, verify its exact issuer/algorithm/auth method, configure TLS/proxy routing, and smoke-test sign-in, `/me` and logout with that provider. A real provider has not been connected in this workspace.

Implementation references: [openid-client discovery](https://github.com/panva/openid-client/blob/main/docs/functions/discovery.md), [authorization-code checks](https://github.com/panva/openid-client/blob/main/docs/interfaces/AuthorizationCodeGrantChecks.md), and [explicit signature validation](https://github.com/panva/openid-client/blob/main/docs/functions/enableNonRepudiationChecks.md).
