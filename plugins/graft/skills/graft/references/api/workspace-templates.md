# Workspace templates

_Set a whole workspace up from a ready-made business template._

Set a whole workspace up from a ready-made business template.

> **Note:** This page is generated from Graft's API catalogue. Base URL is your Graft host; every path below starts with it.
## `GET` `/api/v1/workspace-templates`

The business templates a workspace can start from, as gallery cards.

**Auth:** Bearer token

## `GET` `/api/v1/workspace-templates/:templateId`

One template's full blueprint: toggles, modules, renameable nouns and optional fields.

**Auth:** Bearer token · **Path parameters:** `templateId`

## `POST` `/api/v1/workspace-templates/:templateId/apply`

Build the workspace: every entity, sample record, bookable pool and form the template resolves to. Owner or admin only; a member gets `403 FORBIDDEN`.

**Auth:** Bearer token · **Path parameters:** `templateId`

## `POST` `/api/v1/workspace-templates/:templateId/preview`

What applying the template with these answers would create and what it costs against the plan. Writes nothing.

**Auth:** Bearer token · **Path parameters:** `templateId`
