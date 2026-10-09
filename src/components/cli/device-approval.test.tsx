/** `/device` — approving a `graft login` from the browser (services/device-auth.ts). */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MeResponse } from "@/lib/session";
import { DeviceApproval } from "./device-approval";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const me: MeResponse = {
  user: {
    id: "u1",
    email: "ann@example.com",
    name: "Ann",
    emailVerifiedAt: "2026-10-01T00:00:00Z",
  },
  memberships: [{ tenantId: "t1", slug: "harbour", name: "Harbour Boats", roles: ["owner"] }],
  tenant: {
    id: "t1",
    name: "Harbour Boats",
    slug: "harbour",
    tier: "premium",
    limits: {},
    branding: null,
  },
};

const switchTenant = vi.fn();
let status: "authenticated" | "unauthenticated" = "authenticated";
vi.mock("@/lib/session", () => ({
  useMe: () => ({
    status,
    me: status === "authenticated" ? me : null,
    switchTenant,
    logOut: vi.fn(),
  }),
}));

const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
const notFound = () =>
  new Response(
    JSON.stringify({
      error: {
        code: "NOT_FOUND",
        message: "No pending sign-in request has that code.",
        requestId: "r",
      },
    }),
    { status: 404 },
  );
const pending = {
  userCode: "BCDF-GHJK",
  client: { name: "graft", hostname: "ann-laptop", platform: "darwin-arm64", version: "0.1.0" },
  requestedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  status = "authenticated";
  switchTenant.mockReset();
  fetchMock = vi.fn(async (url: string) =>
    url.endsWith("/lookup") ? ok(pending) : ok({ status: "approved" }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

const bodyOf = (path: string) => {
  const call = fetchMock.mock.calls.find(([url]) => url === path);
  return call ? JSON.parse(call[1].body) : undefined;
};

describe("DeviceApproval", () => {
  it("sends a logged-out visitor to log in and back here", () => {
    status = "unauthenticated";
    render(<DeviceApproval />);
    expect(screen.getByRole("link", { name: "Log in" })).toHaveAttribute(
      "href",
      "/login?redirect=%2Fdevice",
    );
  });

  it("formats the typed code and only continues with all eight letters", async () => {
    const user = userEvent.setup();
    render(<DeviceApproval />);
    const input = screen.getByLabelText("Code");
    await user.type(input, "bcdf");
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    await user.type(input, "ghjk");
    expect(input).toHaveValue("BCDF-GHJK");
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  it("shows who is asking, warns, and approves", async () => {
    const user = userEvent.setup();
    render(<DeviceApproval />);
    await user.type(screen.getByLabelText("Code"), "bcdfghjk");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText("ann-laptop · darwin-arm64")).toBeInTheDocument();
    expect(screen.getByText("ann@example.com")).toBeInTheDocument();
    expect(screen.getByText(/Never approve a code someone else sent you/)).toBeInTheDocument();
    expect(bodyOf("/api/v1/auth/device/lookup")).toEqual({ userCode: "BCDF-GHJK" });

    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("heading", { name: "CLI signed in" })).toBeInTheDocument();
    expect(bodyOf("/api/v1/auth/device/decision")).toEqual({
      userCode: "BCDF-GHJK",
      decision: "approve",
    });
    // Single workspace, already current — no switch.
    expect(switchTenant).not.toHaveBeenCalled();
  });

  it("denies", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/lookup") ? ok(pending) : ok({ status: "denied" }),
    );
    render(<DeviceApproval />);
    await user.type(screen.getByLabelText("Code"), "bcdfghjk");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(await screen.findByRole("button", { name: "Deny" }));

    expect(await screen.findByRole("heading", { name: "Request denied" })).toBeInTheDocument();
    expect(bodyOf("/api/v1/auth/device/decision")).toEqual({
      userCode: "BCDF-GHJK",
      decision: "deny",
    });
  });

  it("shows the server's message for an unknown code and stays on the form", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(notFound());
    render(<DeviceApproval />);
    await user.type(screen.getByLabelText("Code"), "bcdfghjk");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No pending sign-in request has that code.",
    );
    expect(screen.getByLabelText("Code")).toBeInTheDocument();
  });

  it("never reads the code from the URL", () => {
    window.history.replaceState(null, "", "/device?code=BCDF-GHJK&userCode=BCDF-GHJK");
    render(<DeviceApproval />);
    expect(screen.getByLabelText("Code")).toHaveValue("");
  });
});
