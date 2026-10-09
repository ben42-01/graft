# Authentication

_Sign in, send tokens, refresh sessions and switch workspace._

## Access tokens

`POST /api/v1/auth/login` returns a short-lived **access token**: a JWT signed with RS256 that lives for **15 minutes**. Send it on every authenticated request:

```
Authorization: Bearer <accessToken>
```

The token's claims are `sub` (user id), `tid` (workspace id), `roles`, `tier`, `iat`, `exp` and `jti`. **One token is always one workspace.**

You can verify tokens yourself using the public keys at `GET /api/.well-known/jwks.json`. Match on the `kid` in the token header.

## Refresh tokens

Login also sets an opaque **refresh token** as an httpOnly, Secure, SameSite=Lax cookie named `graft_refresh`, valid for 30 days. It is never in the response body.

`POST /api/v1/auth/refresh` with that cookie returns a new access token and a **new refresh cookie**. The refresh token is **rotated on every use**: the old one stops working.

> **Caution:** Replaying a refresh token that was already used is treated as theft. Graft revokes the entire token family, and everyone holding it has to sign in again. Don't run two refreshes in parallel with the same cookie.
A client without a cookie jar (a server integration, say) must store the `Set-Cookie` value from login and refresh itself, and send it back on `POST /api/v1/auth/refresh`.

## Signing out

`POST /api/v1/auth/logout` returns `204` and ends the session. The access token is rejected from then on, even before it would have expired.

## Switching workspace

A user can belong to several workspaces. `POST /api/v1/auth/switch-tenant` with `{ "tenantId": "…" }` returns a token for that workspace. Your earlier token still means the earlier workspace.

## Roles

| Role | Label in the app | Can |
|---|---|---|
| `owner` | Owner | Everything, including team and billing |
| `admin` | Manager | Everything except team and billing; can change forms and manage card payments |
| `member` | Member | Read forms; work with records, orders and customers; cannot change forms |

A refused action returns `403 FORBIDDEN`. Another workspace's data is never visible: asking for it returns `404 NOT_FOUND`, the same as if it did not exist.

## Sign-up and verification

`POST /api/v1/auth/signup` creates an account and a workspace, with a 14-day Premium trial and no card. The account cannot sign in until the emailed link is followed (`POST /api/v1/auth/verify-email`). Until then, login returns `403 EMAIL_NOT_VERIFIED`. `POST /api/v1/auth/resend-verification` sends another link.

## Brute-force protection

Failed logins are limited to 5 per 15 minutes per IP and email. A correct password never spends that budget.
