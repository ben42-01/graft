/**
 * The route-level Suspense fallback for every authenticated screen. Without
 * it, a click on a nav link leaves the old screen up — unchanged — until the
 * next route's code has loaded, which reads as "nothing happened". With it,
 * the shell stays and the content area swaps to a skeleton immediately.
 */
import { LoadingState } from "@/components/shell/loading-state";

export default function AppLoading() {
  return <LoadingState label="Loading…" variant="page" />;
}
