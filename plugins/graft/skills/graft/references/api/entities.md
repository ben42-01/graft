# Entities and records

_Define your own data objects, then read and write their records, including batch imports and images._

Define your own data objects, then read and write their records, including batch imports and images.

> **Note:** This page is generated from Graft's API catalogue. Base URL is your Graft host; every path below starts with it.
## `GET` `/api/v1/entities`

List the workspace's entities. Cursor-paginated: pass `limit` (default 25, max 100) and `cursor` from the previous response's `meta.cursor`.

**Auth:** Bearer token

## `POST` `/api/v1/entities`

Define an entity. Field `type` is one of `text`, `number`, `date`, `select`, `checkbox`, `email`, `phone`, `image`. `select` needs `options`. An `image` field can't be `required`. Keys are lowercase letters, digits and underscores, starting with a letter. Counts against your plan's entity limit.

**Auth:** Bearer token

**Request body**

```json
{
  "key": "bookings",
  "name": "Bookings",
  "fields": [
    {
      "key": "customer",
      "label": "Customer",
      "type": "text",
      "required": true
    },
    {
      "key": "starts_at",
      "label": "Starts",
      "type": "date"
    },
    {
      "key": "status",
      "label": "Status",
      "type": "select",
      "options": [
        "new",
        "confirmed"
      ]
    }
  ]
}
```

## `GET` `/api/v1/entities/:entityId`

One entity with its fields.

**Auth:** Bearer token · **Path parameters:** `entityId`

## `PATCH` `/api/v1/entities/:entityId`

Rename the entity or replace its field list. The `key` is permanent. A structural change to the fields bumps `schemaVersion`; relabelling doesn't.

**Auth:** Bearer token · **Path parameters:** `entityId`

**Request body**

```json
{
  "name": "Appointments"
}
```

## `DELETE` `/api/v1/entities/:entityId`

Delete the entity.

**Auth:** Bearer token · **Path parameters:** `entityId`

## `POST` `/api/v1/entities/:entityId/import-uploads`

Step one of a batch import: get a presigned `PUT` for a CSV or JSON file (up to 25 MB). Needs the `csv_import` feature (Premium and above), otherwise `403 FEATURE_NOT_AVAILABLE`.

**Auth:** Bearer token · **Path parameters:** `entityId`

**Request body**

```json
{
  "contentType": "text/csv",
  "sizeBytes": 20480
}
```

## `POST` `/api/v1/entities/:entityId/import-uploads/:mediaId`

Step two: confirm the file landed.

**Auth:** Bearer token · **Path parameters:** `entityId`, `mediaId`

## `POST` `/api/v1/entities/:entityId/imports`

Run an import from an uploaded file (you send its `mediaId`, never bytes). `mapping` maps source columns to field keys; a column mapped to `null` is skipped. Premium is capped at 10,000 rows per import (`ROW_LIMIT_EXCEEDED`). `format` is `csv` or `json`. `dedupeKey` names a field to match existing records on. `dryRun: true` previews without writing.

**Auth:** Bearer token · **Path parameters:** `entityId`

**Request body**

```json
{
  "mediaId": "000000000000000000000abc",
  "format": "csv",
  "mapping": {
    "Full name": "customer",
    "Notes": null
  },
  "dedupeKey": "email",
  "dryRun": true
}
```

## `GET` `/api/v1/entities/:entityId/imports/:importId`

Re-read the result of one import.

**Auth:** Bearer token · **Path parameters:** `entityId`, `importId`

## `GET` `/api/v1/entities/:entityId/records`

List an entity's records. Cursor-paginated: pass `limit` (default 25, max 100) and `cursor` from the previous response's `meta.cursor`. `filter` is a JSON object of field key to a string, number, boolean or null (exact match); an unknown key is a 400. `sort` must be a field key, `createdAt` or `updatedAt`. Default sort is newest first.

**Auth:** Bearer token · **Path parameters:** `entityId`

## `POST` `/api/v1/entities/:entityId/records`

Create a record. The body is the record's fields directly, validated against a schema compiled from the entity. The response nests them under `data.data`. Counts against your plan's record limit.

**Auth:** Bearer token · **Path parameters:** `entityId`

**Request body**

```json
{
  "customer": "Ada King",
  "starts_at": "2026-10-12T10:00:00Z",
  "status": "new"
}
```

## `GET` `/api/v1/entities/:entityId/records/:recordId`

One record. Add `?includeDeleted=true` to read a soft-deleted one.

**Auth:** Bearer token · **Path parameters:** `entityId`, `recordId`

## `PATCH` `/api/v1/entities/:entityId/records/:recordId`

Change some of a record's fields.

**Auth:** Bearer token · **Path parameters:** `entityId`, `recordId`

**Request body**

```json
{
  "status": "confirmed"
}
```

## `DELETE` `/api/v1/entities/:entityId/records/:recordId`

Soft-delete a record.

**Auth:** Bearer token · **Path parameters:** `entityId`, `recordId`

## `POST` `/api/v1/entities/:entityId/records/:recordId/media`

Step one of an image upload for an `image` field. Returns a presigned `PUT` URL (valid 5 minutes). Upload the bytes straight to it, then call the confirm endpoint. JPEG, PNG and WebP only.

**Auth:** Bearer token · **Path parameters:** `entityId`, `recordId`

**Request body**

```json
{
  "fieldKey": "photo",
  "contentType": "image/png",
  "sizeBytes": 48211
}
```

## `POST` `/api/v1/entities/:entityId/records/:recordId/media/:mediaId`

Step two: confirm the upload landed. Graft checks the object, charges storage and points the field at it.

**Auth:** Bearer token · **Path parameters:** `entityId`, `recordId`, `mediaId`

## `DELETE` `/api/v1/entities/:entityId/records/:recordId/media/:mediaId`

Remove the image from the record.

**Auth:** Bearer token · **Path parameters:** `entityId`, `recordId`, `mediaId`
