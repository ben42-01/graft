import { NextResponse } from "next/server";

/** Liveness — is the process up. No dependencies touched (docs/BACKEND.md §8). */
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    data: { status: "ok", service: "graft", uptimeSeconds: Math.round(process.uptime()) },
  });
}
