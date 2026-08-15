import { jsonOk } from "@/server/http/envelope";
import { route } from "@/server/http/handler";

/** Liveness — is the process up. No dependencies touched (docs/BACKEND.md §8). */
export const dynamic = "force-dynamic";

export const GET = route((_request, { requestId }) =>
  jsonOk(
    { status: "ok", service: "graft", uptimeSeconds: Math.round(process.uptime()) },
    requestId,
  ),
);
