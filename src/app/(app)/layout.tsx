/**
 * The authenticated section's layout — a route group, so it adds no URL
 * segment. `SessionGate` is the auth-redirect guard (AC4): nothing under
 * here renders until `/me` resolves. `ErrorBoundary` (GRAFT-11.5 AC2) wraps
 * every authenticated screen so a thrown render error never surfaces a raw
 * stack trace to the user.
 */
import { ErrorBoundary } from "@/components/shell/error-boundary";
import { SessionGate } from "@/components/shell/session-gate";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionGate>
      <ErrorBoundary>{children}</ErrorBoundary>
    </SessionGate>
  );
}
