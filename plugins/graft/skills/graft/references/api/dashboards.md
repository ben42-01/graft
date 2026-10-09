# Dashboards

_Widget layouts for the overview screen._

Widget layouts for the overview screen.

> **Note:** This page is generated from Graft's API catalogue. Base URL is your Graft host; every path below starts with it.
## `GET` `/api/v1/dashboards`

List dashboards. Cursor-paginated: pass `limit` (default 25, max 100) and `cursor` from the previous response's `meta.cursor`.

**Auth:** Bearer token

## `POST` `/api/v1/dashboards`

Create a dashboard. Widget `type` is `record_list`, `kpi`, `calendar` or `chart`, with a grid `layout` of `x`, `y`, `w`, `h`.

**Auth:** Bearer token

**Request body**

```json
{
  "name": "Overview",
  "widgets": [
    {
      "id": "w1",
      "type": "kpi",
      "config": {},
      "layout": {
        "x": 0,
        "y": 0,
        "w": 3,
        "h": 1
      }
    }
  ]
}
```

## `GET` `/api/v1/dashboards/:dashboardId`

One dashboard.

**Auth:** Bearer token · **Path parameters:** `dashboardId`

## `PATCH` `/api/v1/dashboards/:dashboardId`

Rename it or replace its widgets (max 40).

**Auth:** Bearer token · **Path parameters:** `dashboardId`

**Request body**

```json
{
  "name": "Operations"
}
```

## `DELETE` `/api/v1/dashboards/:dashboardId`

Delete a dashboard.

**Auth:** Bearer token · **Path parameters:** `dashboardId`
