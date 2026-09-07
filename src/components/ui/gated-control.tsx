/**
 * The tier-gated disabled+upgrade-prompt pattern (GRAFT-11.5 AC3,
 * docs/TIERS.md §5): a gated control always renders — never hidden — and
 * when `allowed` is false it disables the control and shows an inline
 * upgrade explanation next to it. `allowed` is a plain boolean the caller
 * derives from the entitlement `/me` already reported (e.g. `tenant.tier`)
 * — this component never decides entitlement itself, only renders it.
 *
 * `upgradeHref` (2026-08-21 UI refinement) turns the explanation into an
 * actionable one: the prompt used to name Premium with no route to buy it.
 * It defaults to `/account`, the in-app plan page. An empty `upgradeMessage`
 * disables the control with no explanation at all — for the moment before
 * the entitlement has loaded, where there is nothing true to say yet.
 */
import type { ReactElement } from "react";
import { cloneElement, isValidElement } from "react";
import Link from "next/link";
import { LockIcon } from "lucide-react";

export function GatedControl({
  allowed,
  upgradeMessage,
  upgradeHref = "/account",
  children,
}: {
  allowed: boolean;
  upgradeMessage: string;
  /** Where the upgrade link points; `null` renders the message with no link. */
  upgradeHref?: string | null;
  children: ReactElement<{ disabled?: boolean }>;
}) {
  const control = isValidElement(children)
    ? cloneElement(children, { disabled: !allowed })
    : children;

  return (
    <div className="inline-flex flex-col items-start gap-1.5">
      {control}
      {!allowed && upgradeMessage ? (
        <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <LockIcon className="size-3" aria-hidden="true" />
          {upgradeMessage}
          {upgradeHref ? (
            <Link
              href={upgradeHref}
              className="font-medium text-graft-green underline-offset-4 hover:underline dark:text-graft-green-light"
            >
              View plans
            </Link>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
