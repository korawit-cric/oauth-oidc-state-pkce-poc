# oauth-oidc-state-pkce-poc

A [knowledge-sharing PoC](https://github.com/korawit-cric/oauth-oidc-state-pkce-poc) for backend-owned OAuth login with `state`, PKCE, and encrypted cookies. It runs against a **local mock identity provider**. It does not connect to ThaiD or authenticate a real person.

## 1. The idea

An external provider handles the user's login. Our backend receives the callback, verifies the login attempt, exchanges the authorization code, and creates **its own application session**. The browser follows redirects and carries cookies; it does not decide whether a callback is valid.

There are two cookies with different jobs:

- `oauth_attempt` is temporary. It holds encrypted `state`, the PKCE verifier, and an expiry during the redirect.
- `app_session` is separate. It holds the application's encrypted identity and expiry after successful login.

## 2. Who is responsible for what?

| Part                | Responsibility in this PoC                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Browser / frontend  | Start login, follow redirects, send cookies, display the result.                                                               |
| NestJS API          | Generate and verify state/PKCE, exchange the code, persist the mapped user through Prisma, and issue/validate the app session. |
| Local mock provider | Return an authorization code and a fixed demo identity. It stands in for an external provider.                                 |

In a real ThaiD integration, ThaiD would authenticate the user. Its actual endpoints, scopes, claims, and client-authentication requirements must come from the integration contract.

## 3. Login flow, step by step

```text
Browser                  NestJS API                 Mock provider
  | GET /auth/login          |                            |
  |------------------------->| create state + PKCE        |
  |<-- oauth_attempt cookie -| redirect with challenge   |
  |-------------------------- redirect ------------------->|
  |<----------------------- code + state -------------------|
  | GET /auth/callback       |                            |
  |------------------------->| verify state and expiry    |
  |                          | exchange code + verifier ->|
  |                          |<-- mock identity ----------|
  |<-- app_session cookie ---| clear oauth_attempt        |
  | GET /dashboard          |                            |
  |------------------------->| validate app_session       |
  |<-- protected page -------|                            |
```

1. `GET /auth/login` generates a random `state` and PKCE verifier. The server encrypts them into the five-minute `oauth_attempt` cookie and redirects the browser with the derived S256 challenge.
2. The mock provider returns an authorization `code` and the original `state` to `/auth/callback`.
3. The callback decrypts the attempt cookie, checks its expiry, compares `state`, and exchanges the code using the saved verifier. A missing, expired, or mismatched attempt is rejected.
4. The NestJS API maps the returned mock identity to an `AppUser` in PostgreSQL through Prisma, clears `oauth_attempt`, and sets a one-hour encrypted `app_session` cookie.
5. On `/dashboard`, the server decrypts `app_session` and checks its expiry. Logout clears the cookie in this browser.

`state` ties the callback to the login that started in this browser. PKCE ties the code exchange to the verifier created by our server. The application session is a new credential for our app; it is not the provider's code or token.

Both cookies use AES-256-GCM authenticated encryption, `HttpOnly`, and `SameSite=Lax`. They use `Secure` in production; HTTP localhost development cannot use a `Secure` cookie. The encryption secret comes from `AUTH_COOKIE_SECRET`, never from source code.

## 4. Other ways to store the login attempt

The backend needs `state`, the PKCE verifier, and an expiry between login start and callback. The supplied authentication guide describes three reasonable locations:

| Approach                        | How callback finds the attempt                    | Good reason to choose it                               | Tradeoff                                                                        |
| ------------------------------- | ------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Redis                           | Look up and atomically consume short-lived state. | Shared across servers; easy one-time use and expiry.   | Another service to run.                                                         |
| PostgreSQL                      | Look up an attempt row and mark it used.          | Durable; useful if PostgreSQL is already operated.     | Extra reads, writes, and cleanup.                                               |
| Encrypted cookie **(this PoC)** | Decrypt the browser's short-lived cookie.         | No login-attempt store; easiest flow to run and study. | No reliable one-time consumption across parallel requests without shared state. |

A signed cookie detects changes but does not hide its contents. Encryption also hides the PKCE verifier. The secret must be stable across app instances and rotated deliberately.

## 5. Other ways to keep the application logged in

After external identity is validated, the backend creates an app session. This is a separate design choice from where the temporary login attempt lives.

| Approach                                  | Browser holds                 | Server does on each request             | Main tradeoff                                              |
| ----------------------------------------- | ----------------------------- | --------------------------------------- | ---------------------------------------------------------- |
| Redis session                             | Opaque session ID             | Look up the active session.             | Fast revocation, but requires Redis.                       |
| PostgreSQL session                        | Opaque session ID             | Look up a non-expired, non-revoked row. | Revocable, but adds a database lookup.                     |
| Encrypted stateless cookie **(this PoC)** | Protected identity and expiry | Decrypt and check expiry.               | No lookup, but a copied cookie remains valid until expiry. |

A hybrid can use the encrypted login-attempt cookie from section 4 and a revocable Redis or PostgreSQL app session here. That may be a better production design when immediate revocation matters.

## 6. Why this PoC chooses encrypted cookies

The purpose is to make the OAuth redirect, `state`, PKCE, callback, and app-session boundary easy to see **without running Redis or storing login attempts/sessions in PostgreSQL**. Two short-lived protected cookies keep the runnable example small. This is the best fit for the PoC's learning goal, not a claim that stateless cookies are best for every production application.

Choose a server-side store when you need one-time login-attempt consumption, immediate session revocation, cross-device logout, or current server-side user data on every request. Redis is useful when it is already operated or traffic is high; PostgreSQL is often simpler when it is already the application's database.

## 7. Run and inspect

Requires Node.js 22.12 or newer and npm. The full base structure is used: `apps/web` provides the UI, `apps/api` owns OAuth and cookies, and PostgreSQL/Prisma stores the mapped application user.

1. Run `npm install` and copy `.env.example` to `.env`.
2. Generate a secret with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` and set it as `AUTH_COOKIE_SECRET` in the root `.env`.
3. Start PostgreSQL with `npm run db:start`, then run `npm run db:generate` and `npm run db:push`.
4. Run `npm run dev` to start both Next.js and NestJS, then open <http://localhost:3000>.
5. Click **Start mock ThaiD login**. In browser developer tools, inspect the redirects, the two cookies, `/dashboard`, and logout.

Keep the root `.env` and its secret out of Git. The repository distributes that file to the apps when `npm run dev` starts.

## 8. Implementation map and limits

- `apps/api/src/auth/`: NestJS controllers and services for login, callback, mock provider, encryption, session validation, and logout.
- `packages/prisma/prisma/schema.prisma`: durable `AppUser` mapping for the external subject.
- `apps/web/app/(home)/page.tsx`: frontend entry point that starts login through the API.
- `apps/web/app/dashboard/page.tsx`: asks the API to validate the cookie before rendering.
- [`apps/web/AUTH_DEMO.md`](apps/web/AUTH_DEMO.md): further production considerations.

The mock provider returns a simplified identity response. A real ThaiD adapter must use registered endpoints and redirect URI, required client authentication, and validation of the actual OIDC identity response (signature, issuer, audience, expiry, nonce where applicable, and claim mapping). Never treat callback query parameters or an unverified decoded token as identity.

This PoC has no one-time mock-code consumption, immediate revocation of a copied cookie, refresh, RBAC/ABAC, tenant checks, audit logs, rate limits, or production CSRF handling. Those are separate concerns to add if the real application requires them.
