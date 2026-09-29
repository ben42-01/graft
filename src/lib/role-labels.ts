/**
 * The one place a tenant role becomes words. The stored role `admin` is shown
 * as "Manager" everywhere tenant-facing, so it is never mistaken for Graft
 * Admin (the platform console, which a tenant admin cannot reach).
 */
const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Manager",
  member: "Member",
};

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? "Member";
}

/** "Owner", or "Manager, Member" for a user holding several roles. */
export function roleLabels(roles: readonly string[]): string {
  return roles.length > 0 ? roles.map(roleLabel).join(", ") : roleLabel("member");
}
