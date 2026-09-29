"use client";

import { LoadingState } from "@/components/shell/loading-state";
import { TeamScreen } from "@/components/team/team-screen";
import { useMe } from "@/lib/session";

export default function TeamPage() {
  const { me } = useMe();
  if (!me) return <LoadingState label="Loading…" />;
  return <TeamScreen me={me} />;
}
