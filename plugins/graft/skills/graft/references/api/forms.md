# Forms

_Build internal and public forms, publish them and manage their images._

Build internal and public forms, publish them and manage their images.

> **Note:** This page is generated from Graft's API catalogue. Base URL is your Graft host; every path below starts with it.
## `GET` `/api/v1/forms`

List forms. Cursor-paginated: pass `limit` (default 25, max 100) and `cursor` from the previous response's `meta.cursor`.

**Auth:** Bearer token

## `POST` `/api/v1/forms`

Create a form: a named, ordered subset of an entity's fields. `visibility` is `internal` or `public`. Optional modes: `catalogue` (visitors browse records), `booking` (a submission becomes an order against real capacity), `payment`, and `content` blocks. A public form is free to draft and counts against the active-form limit when published. Owner or admin only; a member gets `403 FORBIDDEN`.

**Auth:** Bearer token

**Request body**

```json
{
  "entityId": "000000000000000000000015",
  "name": "Book a boat",
  "slug": "book-a-boat",
  "visibility": "public",
  "fields": [
    {
      "key": "customer"
    },
    {
      "key": "starts_at"
    }
  ]
}
```

## `GET` `/api/v1/forms/:formId`

One form with its fields and modes.

**Auth:** Bearer token · **Path parameters:** `formId`

## `PATCH` `/api/v1/forms/:formId`

Change a form. `enabled: false` is the kill switch and outranks `published`. Owner or admin only; a member gets `403 FORBIDDEN`.

**Auth:** Bearer token · **Path parameters:** `formId`

**Request body**

```json
{
  "name": "Book a boat today"
}
```

## `DELETE` `/api/v1/forms/:formId`

Delete a form. Owner or admin only; a member gets `403 FORBIDDEN`.

**Auth:** Bearer token · **Path parameters:** `formId`

## `PUT` `/api/v1/forms/:formId/carousel`

Replace the form's image carousel (currently one image). Owner or admin only; a member gets `403 FORBIDDEN`.

**Auth:** Bearer token · **Path parameters:** `formId`

**Request body**

```json
{
  "images": [
    {
      "mediaId": "000000000000000000000abc",
      "alt": "Our boats"
    }
  ]
}
```

## `POST` `/api/v1/forms/:formId/media`

Step one of a carousel image upload; same two-call pattern as record images.

**Auth:** Bearer token · **Path parameters:** `formId`

**Request body**

```json
{
  "contentType": "image/jpeg",
  "sizeBytes": 90211
}
```

## `POST` `/api/v1/forms/:formId/media/:mediaId`

Step two: confirm the upload and add the slide.

**Auth:** Bearer token · **Path parameters:** `formId`, `mediaId`

## `DELETE` `/api/v1/forms/:formId/media/:mediaId`

Remove the image from the carousel.

**Auth:** Bearer token · **Path parameters:** `formId`, `mediaId`

## `POST` `/api/v1/forms/:formId/publish`

Publish a public form at `/f/{tenantSlug}/{slug}`. Reserves active-form quota. Owner or admin only; a member gets `403 FORBIDDEN`.

**Auth:** Bearer token · **Path parameters:** `formId`

## `POST` `/api/v1/forms/:formId/unpublish`

Take a form offline; its images go dark with it. Owner or admin only; a member gets `403 FORBIDDEN`.

**Auth:** Bearer token · **Path parameters:** `formId`
