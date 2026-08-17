/**
 * The client's shape for a stored widget (GRAFT-13). Mirrors `WidgetConfig`
 * in src/server/services/dashboards.ts but is declared independently, the
 * same way src/lib/session.ts mirrors `MeView` — this tree is "use client"
 * and never imports server-only code.
 */
export type WidgetLayout = { x: number; y: number; w: number; h: number };

export type WidgetInstance = {
  id: string;
  type: string;
  config: Record<string, unknown>;
  layout: WidgetLayout;
};

export type DashboardView = {
  id: string;
  name: string;
  widgets: WidgetInstance[];
  createdAt: string;
  updatedAt: string;
};
