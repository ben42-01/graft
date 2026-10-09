# Authentication

_Create an account, sign in and manage the session._

Create an account, sign in and manage the session.

> **Note:** This page is generated from Graft's API catalogue. Base URL is your Graft host; every path below starts with it.
## `POST` `/api/v1/auth/login`

Exchange an email and password for a session. The response carries the access token; the refresh token is set as an httpOnly cookie. An unverified account gets `403 EMAIL_NOT_VERIFIED`. Failed attempts are rate limited (5 per 15 minutes per IP and email).

**Auth:** None

**Request body**

```json
{
  "email": "owner@example.com",
  "password": "a-long-passphrase"
}
```

**Response**

```json
{
  "data": {
    "accessToken": "eyJhbGciOi…",
    "expiresAt": "2026-10-04T18:30:00.000Z"
  },
  "meta": {
    "requestId": "…"
  }
}
```

## `POST` `/api/v1/auth/logout`

End the session. Returns `204`. The access token is deny-listed immediately.

**Auth:** None

## `POST` `/api/v1/auth/refresh`

Rotate the session using the `graft_refresh` cookie. The old refresh token stops working. Presenting an already-used token revokes the whole token family.

**Auth:** None

## `POST` `/api/v1/auth/resend-verification`

Send a fresh verification link to an unverified account. Always answers the same way, so it can't be used to discover which emails have accounts.

**Auth:** None

**Request body**

```json
{
  "email": "owner@example.com"
}
```

## `POST` `/api/v1/auth/signup`

Create an account and a workspace. Sends a verification email, and the account can't sign in until the address is verified. New workspaces start a 14-day Premium trial with no card. Pass `inviteToken` instead of `businessName` to join an existing workspace.

**Auth:** None

**Request body**

```json
{
  "email": "owner@example.com",
  "password": "a-long-passphrase",
  "businessName": "Bella's Barbershop"
}
```

## `POST` `/api/v1/auth/switch-tenant`

Mint a token for another workspace you belong to. One token is always one workspace.

**Auth:** Bearer token

**Request body**

```json
{
  "tenantId": "000000000000000000000001"
}
```

## `POST` `/api/v1/auth/verify-email`

Spend the token from the verification email.

**Auth:** None

**Request body**

```json
{
  "token": "…"
}
```
