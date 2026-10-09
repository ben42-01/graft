# Submissions

_The inbox of everything visitors have sent through your forms._

The inbox of everything visitors have sent through your forms.

> **Note:** This page is generated from Graft's API catalogue. Base URL is your Graft host; every path below starts with it.
## `GET` `/api/v1/submissions`

The inbox: every form submission, newest first, with its form, sender and the order it raised. Cursor-paginated: pass `limit` (default 25, max 100) and `cursor` from the previous response's `meta.cursor`.

**Auth:** Bearer token
