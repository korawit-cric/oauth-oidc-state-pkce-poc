# oauth-oidc-state-pkce-poc

A knowledge-sharing PoC for a **backend-owned OAuth/OIDC-style login** built with the repository's base architecture:

- **Next.js** renders the UI.
- **NestJS** owns the complete authentication flow and all cookie cryptography.
- **Prisma + PostgreSQL** persist the application user mapped from the external identity.
- A **local mock provider** makes the authorization-code flow runnable without ThaiD credentials.

The mock provider is for learning only. It does not connect to ThaiD or authenticate a real person.

## 1. Core design

The external provider proves identity only during login. After the backend validates that result, it creates its own application user and session.

```text
External identity                    Application identity
-----------------                    --------------------
provider subject: mock-thaid-123  -> PostgreSQL AppUser row
                                  -> encrypted app_session cookie
                                  -> protected application page
```

The browser never decides that login succeeded. It only follows redirects and carries cookies. NestJS validates the callback, performs the code exchange, maps the identity through Prisma, and issues the app session.

## 2. Responsibilities

| Component         | Responsibility                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Next.js frontend  | Starts login through the API, renders login errors, forwards the incoming cookie to the API during protected server rendering, and displays the session result.            |
| NestJS API        | Generates and validates OAuth state and PKCE, owns the callback and token exchange, encrypts/decrypts cookies, persists the mapped user, validates sessions, and logs out. |
| Mock provider     | Validates the demo authorization request, returns a short-lived authorization code, and exchanges it for a fixed demo identity.                                            |
| Prisma/PostgreSQL | Stores the durable `AppUser` record keyed by the provider's unique subject. It does not store the temporary login attempt or app session in this PoC.                      |

## 3. Complete authentication flow

```text
Browser                    NestJS API                   Mock provider             PostgreSQL
  | GET /auth/login            |                              |                         |
  |--------------------------->| create state + verifier      |                         |
  |<-- oauth_attempt cookie ---|                              |                         |
  |<-- redirect ---------------|                              |                         |
  |-------------------------- authorization request --------->|                         |
  |<------------------------ code + original state -----------|                         |
  | GET /auth/callback         |                              |                         |
  |--------------------------->| decrypt attempt cookie       |                         |
  |                            | check state + expiry          |                         |
  |                            | POST code + verifier -------->|                         |
  |                            |<-- external identity ---------|                         |
  |                            | upsert AppUser --------------------------------------->|
  |                            |<------------------------------------------ mapped user |
  |<-- app_session cookie -----| clear oauth_attempt          |                         |
  |<-- redirect /dashboard ----|                              |                         |
  | GET /dashboard            |                              |                         |
  |---------------- Next.js forwards cookie ----------------->|                         |
  |                            | decrypt + validate session   |                         |
  |<-- protected page ---------|                              |                         |
```

### Step 1: Start login

The home page links to `GET /auth/login` on the NestJS API.

NestJS generates two independent random values:

- `state` correlates the callback with the browser that started login.
- `code_verifier` is the PKCE secret. The API sends only its SHA-256 `code_challenge` to the provider.

The API encrypts this temporary payload:

```json
{
  "state": "random value",
  "verifier": "random PKCE verifier",
  "expiresAt": 1234567890
}
```

It returns the payload as an `oauth_attempt` cookie with a five-minute lifetime, then redirects the browser to `/mock-provider/authorize` with:

- `response_type=code`
- `client_id=demo-app`
- the exact callback URL
- `state`
- `code_challenge`
- `code_challenge_method=S256`

### Step 2: Mock provider authorization

`GET /mock-provider/authorize` checks the demo client ID, response type, callback URL, PKCE method, state, and challenge. It creates a short-lived protected authorization code containing the fixed demo identity and the challenge, then redirects to:

```text
GET /auth/callback?code=<protected-code>&state=<original-state>
```

A real ThaiD authorization endpoint would replace this route and authenticate the real user.

### Step 3: Validate callback and exchange the code

`GET /auth/callback` requires all three correlated values:

1. The encrypted `oauth_attempt` cookie.
2. The returned `state` query parameter.
3. The returned authorization `code`.

NestJS decrypts the attempt cookie, rejects expired data, and compares state using a timing-safe equality check. It then calls `POST /mock-provider/token` with the code, original verifier, and callback URL.

The mock token endpoint decrypts the code and verifies:

- the code has not expired;
- the callback URL is identical;
- `SHA-256(code_verifier)` equals the challenge stored in the code.

Only after those checks does it return the demo subject and display name. In a real OIDC integration, the backend would call the provider's token endpoint and validate the returned ID token or user-info response, including signature, issuer, audience, expiry, nonce where required, and claim mapping.

### Step 4: Map the external identity with Prisma

NestJS upserts an `AppUser` using `externalSubject` as the unique key:

```text
AppUser
  id                internal application user ID
  externalSubject   unique provider subject
  displayName       current mapped display name
  createdAt
  updatedAt
```

Returning users resolve to the same application user. A changed display name is updated. The provider's authorization code is never used as the application's user ID.

### Step 5: Create the app session

After the user is mapped, NestJS creates a separate one-hour session payload:

```json
{
  "userId": 1,
  "externalSubject": "mock-thaid-123",
  "displayName": "Demo ThaiD User",
  "expiresAt": 1234567890
}
```

The API clears `oauth_attempt`, sets the encrypted `app_session` cookie, and redirects to the Next.js `/dashboard` page.

### Step 6: Validate protected requests

The dashboard is server-rendered by Next.js. Next.js forwards the browser's cookies to `GET /auth/session` on the NestJS API. NestJS decrypts `app_session`, checks its expiry, and returns the session data. If validation fails, the API returns `401` and Next.js redirects to the home page.

The frontend does not decrypt the cookie and browser JavaScript cannot read it because it is `HttpOnly`.

### Step 7: Logout

The dashboard submits `POST /auth/logout` directly to NestJS. The API expires `app_session` and redirects to the frontend with HTTP `303`.

This removes the cookie from that browser. Because this PoC uses a stateless app session, a copied cookie remains valid until its one-hour expiry.

## 4. Cookie protection

Both cookies use AES-256-GCM authenticated encryption. Each cookie contains:

```text
base64url(initialization-vector).base64url(ciphertext).base64url(authentication-tag)
```

AES-GCM provides confidentiality and tamper detection. The encryption key is derived from `AUTH_COOKIE_SECRET` plus a purpose string:

- `login-attempt` for `oauth_attempt`
- `app-session` for `app_session`
- `mock-code` for the mock provider code

Purpose-specific keys prevent one protected value from being accepted in another context. `AUTH_COOKIE_SECRET` must contain at least 32 random bytes encoded as base64url and must stay out of Git.

Cookie attributes:

| Attribute       | Purpose                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| `HttpOnly`      | Prevents browser JavaScript from reading the credential.                                               |
| `SameSite=Lax`  | Allows the top-level OAuth callback while reducing ordinary cross-site cookie submission.              |
| `Secure`        | Enabled in production so cookies travel only over HTTPS. It is omitted for HTTP localhost development. |
| `Path=/`        | Makes the cookie available to the authentication and application routes.                               |
| Short `Max-Age` | Limits the temporary attempt to five minutes and the app session to one hour.                          |

## 5. Routes

| Method and route               | Owner                | Purpose                                                                            |
| ------------------------------ | -------------------- | ---------------------------------------------------------------------------------- |
| `GET /auth/login`              | NestJS               | Create state/PKCE, set `oauth_attempt`, redirect to the provider.                  |
| `GET /mock-provider/authorize` | NestJS mock provider | Validate the authorization request and return a demo code.                         |
| `POST /mock-provider/token`    | NestJS mock provider | Validate code + PKCE verifier and return the demo identity.                        |
| `GET /auth/callback`           | NestJS               | Validate the attempt, exchange the code, upsert the user, and issue `app_session`. |
| `GET /auth/session`            | NestJS               | Decrypt and validate `app_session`; return `401` when invalid.                     |
| `POST /auth/logout`            | NestJS               | Expire `app_session` and redirect to the frontend.                                 |
| `GET /dashboard`               | Next.js              | Forward cookies to the API and render the protected page after validation.         |

## 6. Why encrypted cookies are used

This PoC deliberately avoids Redis and avoids storing login attempts or sessions in PostgreSQL. That keeps the learning flow small while still using PostgreSQL for durable application-user mapping.

Alternative designs:

| State to store | Redis                                                  | PostgreSQL                                    | Encrypted cookie used here                                                             |
| -------------- | ------------------------------------------------------ | --------------------------------------------- | -------------------------------------------------------------------------------------- |
| Login attempt  | Shared TTL entry that can be atomically consumed once. | Attempt row with expiry and `usedAt`.         | No backend lookup, but reliable one-time consumption requires additional shared state. |
| App session    | Opaque ID with fast lookup and immediate revocation.   | Opaque ID with durable lookup and revocation. | No lookup, but a copied cookie works until expiry.                                     |

Use Redis or PostgreSQL-backed sessions when immediate revocation, cross-device logout, one-time attempt consumption, or current server-side user data on every request matters. A useful hybrid is an encrypted login-attempt cookie followed by a revocable server-side app session.

## 7. Run locally

Requirements: Node.js 22.12 or newer, npm, and Docker.

1. Install dependencies and create the environment file:

   ```bash
   npm install
   cp .env.example .env
   ```

2. Generate a cookie secret and place it in the root `.env`:

   ```bash
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
   ```

   ```env
   AUTH_COOKIE_SECRET=<generated-value>
   ```

3. Start PostgreSQL and apply the Prisma schema:

   ```bash
   npm run db:start
   npm run db:generate
   npm run db:push
   ```

4. Start Next.js and NestJS through Turborepo:

   ```bash
   npm run dev
   ```

5. Open <http://localhost:3000> and click **Start mock ThaiD login**.

The root `.env` is distributed to the apps by the repository's development script. Keep it out of source control.

## 8. Configuration

| Variable              | Default/example                | Used for                                                                       |
| --------------------- | ------------------------------ | ------------------------------------------------------------------------------ |
| `DATABASE_URL`        | PostgreSQL on `localhost:5433` | Prisma database connection.                                                    |
| `API_PORT`            | `3001`                         | NestJS listener.                                                               |
| `API_PUBLIC_URL`      | `http://localhost:3001`        | OAuth callback and provider URLs. Must match the browser-reachable API origin. |
| `WEB_URL`             | `http://localhost:3000`        | Success, failure, and logout redirects.                                        |
| `NEXT_PUBLIC_API_URL` | `http://localhost:3001`        | Frontend link and server-side API calls.                                       |
| `AUTH_COOKIE_SECRET`  | No default                     | Master secret for authenticated encryption.                                    |
| `NODE_ENV`            | `development`                  | Enables the `Secure` cookie flag in production.                                |

For the current cross-port localhost setup, both apps use the same `localhost` host, so cookies are shared by host regardless of port. A deployment using different hostnames needs a deliberate same-site domain, reverse proxy, or backend-for-frontend cookie strategy.

## 9. Code map

- `apps/api/src/auth/auth.controller.ts`: HTTP routes, redirects, cookies, and mock-provider endpoints.
- `apps/api/src/auth/auth.service.ts`: state/PKCE flow, mock-code checks, Prisma mapping, and session creation.
- `apps/api/src/auth/auth.crypto.ts`: AES-GCM sealing/opening, random secrets, PKCE challenge, and timing-safe comparison.
- `apps/api/src/auth/auth.types.ts`: login-attempt, mock-code, and app-session payloads.
- `packages/prisma/prisma/schema.prisma`: durable `AppUser` model.
- `apps/web/app/(home)/page.tsx`: login entry point and error display.
- `apps/web/app/dashboard/page.tsx`: server-side session check and protected result.

## 10. Deliberate limitations

This repository demonstrates authentication mechanics, not a complete production identity system. It does not include:

- real ThaiD endpoints or real user authentication;
- one-time consumption of the mock authorization code;
- immediate revocation of a copied stateless session;
- refresh tokens or silent renewal;
- RBAC, ABAC, tenant authorization, or business permissions;
- production-grade CSRF handling for general state-changing routes;
- rate limiting, audit events, device sessions, or encryption-key rotation.

Add those according to the real application's threat model and operational requirements.
