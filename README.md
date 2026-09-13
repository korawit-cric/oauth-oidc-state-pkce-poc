# oauth-oidc-state-pkce-poc

A [knowledge-sharing repository](https://github.com/korawit-cric/oauth-oidc-state-pkce-poc) for understanding how an application can use an external identity provider, then establish and enforce its own browser session. The runnable Next.js demo uses a **local mock provider**, not ThaiD. It does not authenticate a real person or call ThaiD endpoints.

## What this PoC teaches

Authentication with an external provider and authorization inside an application are different responsibilities. The provider establishes an identity; the application validates that result, maps it to an application user, creates a session, and checks access to its own resources. The browser never decides that a callback proves identity on its own.

```text
Browser                 App server                   Mock provider
   | GET /auth/login         |                              |
   |------------------------>| generate state + PKCE       |
   |<-- encrypted attempt ---| redirect with challenge     |
   |------------------------ redirect --------------------->|
   |<------------------- code + state ----------------------|
   | GET /auth/callback      |                              |
   |------------------------>| verify state and expiry     |
   |                         | exchange code + verifier --->|
   |                         |<--- mock identity -----------|
   |<-- encrypted session ---| map to app user              |
   | GET /dashboard         |                              |
   |------------------------>| validate app session        |
```

The temporary `oauth_attempt` cookie contains a random `state`, a PKCE verifier, and a five-minute expiry. AES-256-GCM provides both confidentiality and tamper detection. The callback compares state, uses the verifier to exchange the code, and clears the attempt cookie. A separate `app_session` cookie holds the mapped application identity and a one-hour expiry. Both cookies are `HttpOnly` and `SameSite=Lax`; they are `Secure` in production. The dashboard validates the app session on the server. Logging out clears it.

## Why this design

This PoC isolates the trust boundaries while keeping the exercise runnable without Redis, PostgreSQL, or ThaiD credentials. A protected short-lived cookie lets the app correlate a login attempt across the redirect without a server-side login-attempt store. A separate app session means business requests use the application's identity and authorization model rather than presenting the provider response on every request. The tradeoff is that stateless cookies are harder to revoke immediately or consume exactly once.

| Approach                    | Where login state and session live                                                | Useful when                                                            | Main tradeoff                                     |
| --------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------- |
| Encrypted cookie (this PoC) | Browser carries protected state and app session                                   | Small demos or systems that accept short expiry and limited revocation | Replay and immediate revocation need extra design |
| Redis-backed                | Server stores short-lived login attempts and sessions; browser carries opaque IDs | Many app instances, high request volume, or immediate revocation       | Extra service to operate                          |
| PostgreSQL-backed           | Server stores login attempts and sessions; browser carries opaque IDs             | A database already exists and simpler operations matter                | Database read/write on the auth path              |
| Hybrid                      | Protected login-state cookie, server-side app session                             | Avoid login-attempt storage but retain revocable sessions              | Two lifecycle models to maintain                  |

A signed cookie alone protects integrity but does not hide the PKCE verifier; authenticated encryption does both. Regardless of storage, `state` correlates the callback to the initiating browser, PKCE binds the authorization code to the verifier, and the backend must validate the provider's identity result. These mechanisms solve different problems.

## Run the demo

Requires Node.js 22.12 or newer and npm. The authentication demo runs through `apps/web`; the NestJS API and database directories are present but are not used in this flow.

1. Install dependencies: `npm install`.
2. Generate a secret: `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`.
3. Put it in `apps/web/.env.local` as `AUTH_COOKIE_SECRET=<generated value>`.
4. Run `npm run dev --workspace=web`, open <http://localhost:3000>, and click **Start mock ThaiD login**.
5. Inspect the redirects, `oauth_attempt` and `app_session` cookies, `/dashboard`, and logout in browser developer tools.

Keep the secret out of Git. If you use the root `npm run dev` command, place the secret in the root `.env` so the repository's environment-distribution script can share it with the app.

## Code map

- `apps/web/app/auth/login/route.ts`: generate state and PKCE, set the temporary cookie, redirect.
- `apps/web/app/mock-provider/`: local authorization and token endpoints for teaching.
- `apps/web/app/auth/callback/route.ts`: verify the callback, exchange the code, create the app session.
- `apps/web/lib/auth/`: authenticated encryption and flow types.
- `apps/web/app/dashboard/page.tsx`: server-side session check.
- `apps/web/app/auth/logout/route.ts`: clear cookies.
- [`apps/web/AUTH_DEMO.md`](apps/web/AUTH_DEMO.md): detailed flow and production gaps.

## Boundaries and next steps

The mock provider returns a simplified identity response. A real ThaiD adapter needs the registered endpoints, exact redirect URI, required client authentication, and validation of the actual OIDC identity result, including signature, issuer, audience, expiry, nonce where applicable, and claim mapping. Do not treat a callback query parameter or an unverified decoded token as identity.

The current mock code is not one-time. The app session is stateless, so clearing one browser's cookie does not revoke a copied cookie. The PoC also does not implement durable user mapping, RBAC/ABAC, tenant checks, audit logs, rate limits, or a production CSRF strategy for state-changing actions. Those are application responsibilities to add before real use; roles and permissions must be enforced server-side against current data.
