/**
 * The tier-gated disabled+upgrade-prompt pattern (GRAFT-11.5 AC3,
 * docs/TIERS.md §5): a gated control always renders — never hidden — and
 * when `allowed` is false it disables the control and shows an inline
 * upgrade explanation next to it. `allowed` is a plain boolean the caller
 * derives from the entitlement `/me` already reported (e.g. `tenant.tier`)
 * — this component never decides entitlement itself, only renders it.
 */
import type { ReactElement } from "react";
import { cloneElement, isValidElement } from "react";
import { LockIcon } from "lucide-react";

export function GatedControl({
  allowed,
  upgradeMessage,
  children,
}: {
  allowed: boolean;
  upgradeMessage: string;
  children: ReactElement<{ disabled?: boolean }>;
}) {
  const control = isValidElement(children)
    ? cloneElement(children, { disabled: !allowed })
    : children;

  return (
    <div className="inline-flex flex-col items-start gap-1.5">
      {control}
      {!allowed ? (
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <LockIcon className="size-3" aria-hidden="true" />
          {upgradeMessage}
        </p>
      ) : null}
    </div>
  );
}
