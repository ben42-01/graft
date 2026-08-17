/**
 * The authenticated section's layout — a route group, so it adds no URL
 * segment. `SessionGate` is the auth-redirect guard (AC4): nothing under
 * here renders until `/me` resolves.
 */
import { SessionGate } from "@/components/shell/session-gate";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <SessionGate>{children}</SessionGate>;
}
