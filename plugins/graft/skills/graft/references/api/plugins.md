# Plugins

_Switch workspace capabilities on and off._

Switch workspace capabilities on and off.

> **Note:** This page is generated from Graft's API catalogue. Base URL is your Graft host; every path below starts with it.
## `GET` `/api/v1/plugins`

The plugin catalogue for this workspace, with what is enabled.

**Auth:** Bearer token

## `POST` `/api/v1/plugins/:pluginId/disable`

Disable a plugin.

**Auth:** Bearer token · **Path parameters:** `pluginId`

## `POST` `/api/v1/plugins/:pluginId/enable`

Enable a plugin. Plugins that provision forms need owner or admin. A plan limit gives `403 QUOTA_EXCEEDED`.

**Auth:** Bearer token · **Path parameters:** `pluginId`
