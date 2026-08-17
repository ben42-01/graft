"use client";

/**
 * Lists exactly the workspaces `/me` reported (AC1); on selection, defers to
 * `onSwitch` (`useMe().switchTenant`), which POSTs switch-tenant and
 * re-fetches `/me` (GRAFT-03.2 AC6). Never decides membership itself.
 */
import { useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { MembershipView } from "@/lib/session";

export function TenantSwitcher({
  activeTenantId,
  memberships,
  onSwitch,
}: {
  activeTenantId: string;
  memberships: MembershipView[];
  onSwitch: (tenantId: string) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);

  const handleChange = async (tenantId: string) => {
    if (tenantId === activeTenantId || pending) return;
    setPending(true);
    try {
      await onSwitch(tenantId);
    } finally {
      setPending(false);
    }
  };

  return (
    <Select value={activeTenantId} onValueChange={handleChange} disabled={pending}>
      <SelectTrigger aria-label="Switch workspace" className="w-full sm:w-56">
        <SelectValue placeholder="Select a workspace" />
      </SelectTrigger>
      <SelectContent>
        {memberships.map((membership) => (
          <SelectItem key={membership.tenantId} value={membership.tenantId}>
            {membership.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
