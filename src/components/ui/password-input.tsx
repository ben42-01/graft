"use client";

/**
 * A password `Input` with a reveal toggle (2026-08-21 UI refinement).
 *
 * Typing a 12-character minimum (`PASSWORD_MIN_LENGTH`, `src/server/auth/
 * passwords.ts`) blind is the single most error-prone moment in the auth
 * flow, and a mistyped password on `/signup` is only discovered a whole
 * email-verification round trip later.
 *
 * The toggle flips `type` between `password` and `text` rather than keeping a
 * shadow value, so the browser's own password manager still recognises the
 * field. It is `type="button"` — inside a `<form>` an untyped button submits.
 *
 * Its accessible name deliberately contains the word "password", which makes
 * `getByLabel("Password")` ambiguous in Playwright; the auth specs pin the
 * field with `{ exact: true }`.
 */
import * as React from "react";
import { Eye, EyeOff } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export function PasswordInput({
  className,
  ...props
}: Omit<React.ComponentProps<typeof Input>, "type">) {
  const [visible, setVisible] = React.useState(false);
  const Icon = visible ? EyeOff : Eye;

  return (
    <div className="relative">
      <Input
        {...props}
        type={visible ? "text" : "password"}
        className={cn("pr-9", className)}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        className="absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-md text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <Icon aria-hidden className="size-4" />
      </button>
    </div>
  );
}
