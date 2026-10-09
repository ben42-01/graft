# Team

_Invite people and manage seats. Owner only._

Invite people and manage seats. Owner only.

> **Note:** This page is generated from Graft's API catalogue. Base URL is your Graft host; every path below starts with it.
## `GET` `/api/v1/team`

Members, pending invites and seats (`used` and `limit`). Owner only.

**Auth:** Bearer token

## `POST` `/api/v1/team/invites`

Create an invite link as owner. The raw token appears once, inside `url`, and is never stored. Invites expire after 7 days. Seat arithmetic: members plus pending invites must stay under the plan's seat limit, else `403 QUOTA_EXCEEDED` with `details.meter = "seats"`.

**Auth:** Bearer token

**Request body**

```json
{
  "role": "member",
  "email": "sam@example.com"
}
```

**Response**

```json
{
  "data": {
    "invite": {
      "id": "…",
      "role": "member",
      "email": "sam@example.com",
      "expiresAt": "…"
    },
    "url": "https://…/invite/<token>"
  }
}
```

## `DELETE` `/api/v1/team/invites/:inviteId`

Revoke a pending invite. Returns `204`.

**Auth:** Bearer token · **Path parameters:** `inviteId`

## `POST` `/api/v1/team/invites/accept`

A signed-in user takes the seat an invite offers.

**Auth:** Bearer token

**Request body**

```json
{
  "token": "…"
}
```

## `DELETE` `/api/v1/team/members/:userId`

Remove someone from the workspace. Returns `204`. The owner can't remove themselves.

**Auth:** Bearer token · **Path parameters:** `userId`
