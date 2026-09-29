/**
 * GRAFT-33.3 — the Team screen. The API is stubbed at `fetch`; what is under
 * test is what the owner sees and which calls the screen makes.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamScreen } from "./team-screen";
import type { MeResponse } from "@/lib/session";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const meWith = (roles: string[]): MeResponse => ({
  user: { id: "u1", email: "owner@example.test", name: null, emailVerifiedAt: null },
  memberships: [{ tenantId: "t1", slug: "co", name: "Co", roles }],
  tenant: { id: "t1", name: "Co", slug: "co", tier: "premium", limits: {}, branding: null },
});

const TEAM = {
  members: [
    { userId: "u1", email: "owner@example.test", roles: ["owner"], isYou: true },
    { userId: "u2", email: "sam@example.test", roles: ["admin"], isYou: false },
    { userId: "u3", email: "kim@example.test", roles: ["member"], isYou: false },
  ],
  invites: [
    { id: "i1", role: "member", email: "new@example.test", expiresAt: "2026-10-06T00:00:00Z" },
  ],
  seats: { used: 4, limit: 15 },
};

const ok = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status });
const refused = (code: string, status: number) =>
  new Response(JSON.stringify({ error: { code, message: code, requestId: "r" } }), { status });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const calls = () =>
  fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? "GET"} ${url}`);

describe("TeamScreen", () => {
  it("AC1 — lists members, invites and seats used of limit", async () => {
    fetchMock.mockResolvedValue(ok(TEAM));
    render(<TeamScreen me={meWith(["owner"])} />);

    expect(await screen.findByText("sam@example.test")).toBeInTheDocument();
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.getByTestId("seat-count")).toHaveTextContent("4 of 15 seats used");
    expect(screen.getByText(/Manager · expires|Member · expires/)).toBeInTheDocument();
    expect(screen.getByText("new@example.test")).toBeInTheDocument();
  });

  it("AC1 — creating an invite shows the returned url, and Copy puts it on the clipboard with a polite announcement", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? ok({ invite: TEAM.invites[0], url: "https://graft.test/invite/abc" }, 201)
        : ok(TEAM),
    );
    render(<TeamScreen me={meWith(["owner"])} />);

    await user.click(await screen.findByRole("button", { name: "Invite someone" }));
    const dialog = screen.getByRole("dialog", { name: "Invite someone" });
    await user.selectOptions(within(dialog).getByLabelText("Role"), "admin");
    await user.click(within(dialog).getByRole("button", { name: "Create link" }));

    expect(
      await within(dialog).findByDisplayValue("https://graft.test/invite/abc"),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/works once and expires in 7 days/)).toBeInTheDocument();
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(post![1].body)).toEqual({ role: "admin" });

    await user.click(within(dialog).getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("https://graft.test/invite/abc");
    expect(await within(dialog).findByRole("status")).toHaveTextContent("Link copied");
  });

  it("AC2 — at the seat limit there is no invite button, only the explanation and an upgrade link", async () => {
    fetchMock.mockResolvedValue(ok({ ...TEAM, seats: { used: 15, limit: 15 } }));
    render(<TeamScreen me={meWith(["owner"])} />);

    expect(await screen.findByTestId("seat-explanation")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Invite someone" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Upgrade your plan" })).toHaveAttribute(
      "href",
      "/account",
    );
  });

  it("AC2 — a QUOTA_EXCEEDED race shows the same explanation", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === "POST" ? refused("QUOTA_EXCEEDED", 403) : ok(TEAM),
    );
    render(<TeamScreen me={meWith(["owner"])} />);

    await user.click(await screen.findByRole("button", { name: "Invite someone" }));
    await user.click(screen.getByRole("button", { name: "Create link" }));

    expect(await screen.findByTestId("seat-explanation")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Invite someone" })).not.toBeInTheDocument();
  });

  it.each([["admin"], ["member"]])(
    "AC3 — a %s sees only the owner message and makes no request",
    (role) => {
      render(<TeamScreen me={meWith([role])} />);

      expect(
        screen.getByText("Only the workspace owner can manage the team."),
      ).toBeInTheDocument();
      expect(screen.queryByText("sam@example.test")).not.toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("AC4 — removing a member asks first, then calls DELETE and refreshes; the owner row has no remove", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === "DELETE" ? ok({}) : ok(TEAM),
    );
    render(<TeamScreen me={meWith(["owner"])} />);
    await screen.findByText("sam@example.test");

    expect(
      screen.queryByRole("button", { name: "Remove owner@example.test" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove sam@example.test" }));
    expect(calls().some((c) => c.startsWith("DELETE"))).toBe(false);

    const dialog = screen.getByRole("dialog", { name: "Remove member?" });
    const before = fetchMock.mock.calls.length;
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(calls()).toContain("DELETE /api/v1/team/members/u2"));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before + 1));
    expect(calls().slice(before)).toEqual([
      "DELETE /api/v1/team/members/u2",
      "GET /api/v1/team",
    ]);
  });

  it("AC4 — revoking an invite asks first, then calls DELETE and refreshes", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === "DELETE" ? ok({}) : ok(TEAM),
    );
    render(<TeamScreen me={meWith(["owner"])} />);

    await user.click(
      await screen.findByRole("button", { name: "Revoke invite for new@example.test" }),
    );
    expect(calls().some((c) => c.startsWith("DELETE"))).toBe(false);
    await user.click(
      within(screen.getByRole("dialog", { name: "Revoke invite?" })).getByRole("button", {
        name: "Revoke",
      }),
    );

    await waitFor(() => expect(calls()).toContain("DELETE /api/v1/team/invites/i1"));
  });

  it("AC4 — cancelling the confirm makes no request", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(ok(TEAM));
    render(<TeamScreen me={meWith(["owner"])} />);

    await user.click(await screen.findByRole("button", { name: "Remove kim@example.test" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(calls().some((c) => c.startsWith("DELETE"))).toBe(false);
  });

  it("AC7 — role labels come from the helper: Manager and Member, never admin", async () => {
    fetchMock.mockResolvedValue(ok(TEAM));
    const { container } = render(<TeamScreen me={meWith(["owner"])} />);
    await screen.findByText("sam@example.test");

    expect(screen.getByText("Owner")).toBeInTheDocument();
    expect(screen.getByText("Manager")).toBeInTheDocument();
    expect(screen.getAllByText("Member").length).toBeGreaterThan(0);
    expect(container.textContent?.toLowerCase()).not.toMatch(/\badmin\b/);
  });

  it("AC8 — the dialog is labelled by its title and keeps focus inside", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(ok(TEAM));
    render(<TeamScreen me={meWith(["owner"])} />);

    await user.click(await screen.findByRole("button", { name: "Invite someone" }));
    const dialog = screen.getByRole("dialog", { name: "Invite someone" });
    for (let i = 0; i < 8; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });
});
