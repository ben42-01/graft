/**
 * Anything under /api/v1 that no route claims answers with the standard error
 * envelope (docs/BACKEND.md §2) instead of Next.js's HTML 404 page. An API that
 * sometimes replies in HTML is an API clients have to special-case.
 *
 * More specific route segments always win over this catch-all, so real
 * endpoints are unaffected as they land.
 */
import { AppError } from "@/server/http/envelope";
import { route } from "@/server/http/handler";

export const dynamic = "force-dynamic";

const noSuchRoute = route<{ path: string[] }>((request) => {
  const { pathname } = new URL(request.url);
  throw new AppError("NOT_FOUND", `No API route matches ${request.method} ${pathname}`);
});

export const GET = noSuchRoute;
export const POST = noSuchRoute;
export const PUT = noSuchRoute;
export const PATCH = noSuchRoute;
export const DELETE = noSuchRoute;
export const HEAD = noSuchRoute;
export const OPTIONS = noSuchRoute;
