# Records

_Add, edit, find, import and export the data under an entity._

A record is one row under an entity: one customer, one job, one boat.

## Adding and editing

Open an entity and choose **Add record**. The form is generated from the entity's fields, and required fields are enforced before saving. Open a record to edit it. Deleting a record is a soft delete.

Records also arrive from [forms](../forms/): every submission creates a record in the form's entity.

## Finding records

Records are listed newest first. Through the API you can also sort and filter on any field of the entity.

## Pictures

An entity with an **Image** field lets you attach a photo to each record, which can then show on a public catalogue form. Images must be JPEG, PNG or WebP, and they count against your storage.

## Exporting

CSV export is available on every plan.

## Importing records

Batch CSV or JSON import is a **Premium** feature (on Free you get a prompt naming it).

1. Choose the file, up to 25 MB.
2. **Map** each source column to an entity field. A column you map to nothing is skipped. A column with no mapping maps to the field of the same name.
3. Optionally choose a **dedupe field** to match existing records.
4. Run a **dry run** first to preview what would happen without writing anything.
5. Import. Premium handles up to 10,000 rows per import; Enterprise is unlimited.

## Limits

Records per workspace: Free 2,000, Premium 100,000, Enterprise unlimited (fair use).
