/**
 * GRAFT-27.4 AC10 — the tier-override control on the `/admin/tenants/[id]`
 * screen.
 *
 * Three properties, and all three are about *not* doing something:
 *
 *   - the operator cannot reach the confirm step without typing a reason;
 *   - the confirm step names the tenant and says in plain words that Stripe
 *     billing is not changed by this action;
 *   - cancelling — at either step — issues no request at all.
 *
 * The last one is asserted against the fetch spy's call count rather than
 * against the absence of a success message, because "no request was sent" is
 * the claim, and a component that sent one and ignored the response would
 * satisfy the weaker assertion.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TierOverrideDialog } from "./tier-override-dialog";

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light", setTheme: vi.fn() }),
}));

const TENANT = {
  id: "000000000000000000000004",
  name: "Downgraded Co",
  slug: "qa-downgraded",
  tier: "free",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function okFetch() {
  return vi.fn().mockResolvedValue(
    jsonResponse({
      data: {
        id: TENANT.id,
        fromTier: "free",
        toTier: "premium",
        changed: true,
        readOnly: [],
      },
      meta: { requestId: "req-1" },
    }),
  );
}

/** Open the control and fill in tier + reason, stopping before confirming. */
async function openAndFill(
  user: ReturnType<typeof userEvent.setup>,
  reason = "comped for launch partner",
) {
  await user.click(screen.getByRole("button", { name: /change tier/i }));
  await user.selectOptions(screen.getByLabelText(/new tier/i), "premium");
  if (reason) await user.type(screen.getByLabelText(/reason/i), reason);
}

describe("TierOverrideDialog", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("AC10 — will not advance to the confirm step until a reason has been typed", async () => {
    const fetchSpy = okFetch();
    vi.stubGlobal("fetch", fetchSpy);
    const user = userEvent.setup();
    render(<TierOverrideDialog tenant={TENANT} />);

    await openAndFill(user, "");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    expect(screen.getByText(/a reason is required/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^confirm tier change$/i })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("AC10 — a reason of only whitespace is not a reason", async () => {
    const fetchSpy = okFetch();
    vi.stubGlobal("fetch", fetchSpy);
    const user = userEvent.setup();
    render(<TierOverrideDialog tenant={TENANT} />);

    await openAndFill(user, "    ");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    expect(screen.getByText(/a reason is required/i)).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("AC10 — the confirm step names the tenant and states that Stripe billing is not changed", async () => {
    vi.stubGlobal("fetch", okFetch());
    const user = userEvent.setup();
    render(<TierOverrideDialog tenant={TENANT} />);

    await openAndFill(user);
    await user.click(screen.getByRole("button", { name: /continue/i }));

    const confirm = screen.getByRole("dialog");
    // Named, not "this tenant" — an operator with several tabs open must be
    // able to see which workspace they are about to move.
    expect(confirm).toHaveTextContent("Downgraded Co");
    expect(confirm).toHaveTextContent("qa-downgraded");
    expect(confirm).toHaveTextContent(/free/i);
    expect(confirm).toHaveTextContent(/premium/i);
    // The out-of-scope warning the contract requires, in words.
    expect(confirm).toHaveTextContent(/stripe/i);
    expect(confirm).toHaveTextContent(/billing is not changed|does not change .*billing/i);
  });

  it("AC10 — cancelling from the confirm step issues no request", async () => {
    const fetchSpy = okFetch();
    vi.stubGlobal("fetch", fetchSpy);
    const user = userEvent.setup();
    render(<TierOverrideDialog tenant={TENANT} />);

    await openAndFill(user);
    await user.click(screen.getByRole("button", { name: /continue/i }));
    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    // Back to the resting state, with nothing half-applied on screen.
    expect(screen.getByRole("button", { name: /change tier/i })).toBeInTheDocument();
  });

  it("AC10 — confirming POSTs the tier and the reason exactly once, and reports the outcome", async () => {
    const fetchSpy = okFetch();
    vi.stubGlobal("fetch", fetchSpy);
    const onApplied = vi.fn();
    const user = userEvent.setup();
    render(<TierOverrideDialog tenant={TENANT} onApplied={onApplied} />);

    await openAndFill(user);
    await user.click(screen.getByRole("button", { name: /continue/i }));
    await user.click(screen.getByRole("button", { name: /^confirm tier change$/i }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/v1/admin/tenants/${TENANT.id}/tier`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      tier: "premium",
      reason: "comped for launch partner",
    });

    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/free.*→.*premium|now on premium/i)).toBeInTheDocument();
  });

  it("AC10 — a rejected override surfaces the error and leaves the screen honest about it", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: "VALIDATION_FAILED",
            message: "Invalid request body",
            requestId: "r",
          },
        },
        400,
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const onApplied = vi.fn();
    const user = userEvent.setup();
    render(<TierOverrideDialog tenant={TENANT} onApplied={onApplied} />);

    await openAndFill(user);
    await user.click(screen.getByRole("button", { name: /continue/i }));
    await user.click(screen.getByRole("button", { name: /^confirm tier change$/i }));

    expect(await screen.findByText(/couldn't change the tier/i)).toBeInTheDocument();
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("AC10 — closing the first step before confirming issues no request either", async () => {
    const fetchSpy = okFetch();
    vi.stubGlobal("fetch", fetchSpy);
    const user = userEvent.setup();
    render(<TierOverrideDialog tenant={TENANT} />);

    await openAndFill(user);
    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/reason/i)).toBeNull();
  });
});
