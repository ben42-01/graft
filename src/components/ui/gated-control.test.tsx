/**
 * GRAFT-11.5 Test Contract — `GatedControl` (AC3): renders disabled with an
 * inline upgrade explanation when the mocked entitlement is `false`, and
 * renders normally when `true`. The `allowed` value below is derived the
 * same way a caller would derive it from a `/me`-shaped response
 * (`me.tenant.tier !== "free"`), not an invented client-side flag.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GatedControl } from "./gated-control";

type MockMeResponse = { tenant: { tier: string } };

function entitlementFromMe(me: MockMeResponse): boolean {
  return me.tenant.tier !== "free";
}

describe("GatedControl", () => {
  it("AC3 — renders disabled with an inline upgrade explanation when the mocked /me entitlement says no", () => {
    const me: MockMeResponse = { tenant: { tier: "free" } };

    render(
      <GatedControl
        allowed={entitlementFromMe(me)}
        upgradeMessage="Upgrade to Premium to unlock this."
      >
        <button type="button">Add entity</button>
      </GatedControl>,
    );

    expect(screen.getByRole("button", { name: "Add entity" })).toBeDisabled();
    expect(screen.getByText("Upgrade to Premium to unlock this.")).toBeInTheDocument();
  });

  it("AC3 — renders normally, with no upgrade explanation, when the mocked /me entitlement says yes", () => {
    const me: MockMeResponse = { tenant: { tier: "premium" } };

    render(
      <GatedControl
        allowed={entitlementFromMe(me)}
        upgradeMessage="Upgrade to Premium to unlock this."
      >
        <button type="button">Add entity</button>
      </GatedControl>,
    );

    expect(screen.getByRole("button", { name: "Add entity" })).toBeEnabled();
    expect(screen.queryByText("Upgrade to Premium to unlock this.")).not.toBeInTheDocument();
  });
});
