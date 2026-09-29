/** GRAFT-33.3 — the invite landing page (AC5, AC6). */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InviteLanding } from "./invite-landing";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, push: vi.fn() }) }));

const switchTenant = vi.fn();
let status: "authenticated" | "unauthenticated" = "authenticated";
vi.mock("@/lib/session", () => ({
  useMe: () => ({ status, me: null, switchTenant, logOut: vi.fn() }),
}));

const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
const notFound = () =>
  new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "x", requestId: "r" } }), {
    status: 404,
  });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  status = "authenticated";
  replace.mockReset();
  switchTenant.mockReset();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

describe("InviteLanding", () => {
  it("AC5 — shows workspace and role label for a valid token", async () => {
    fetchMock.mockResolvedValue(ok({ workspaceName: "Harbour Boats", role: "admin" }));
    render(<InviteLanding token="tok" />);

    expect(
      await screen.findByRole("heading", { name: "Join Harbour Boats as Manager" }),
    ).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/public/invites/tok");
  });

  it("AC5 — a signed-in user can Join and is switched into that workspace", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/accept")
        ? ok({ tenantId: "t9", tenantSlug: "harbour", role: "member" })
        : ok({ workspaceName: "Harbour Boats", role: "member" }),
    );
    render(<InviteLanding token="tok" />);

    await user.click(await screen.findByRole("button", { name: "Join" }));

    await waitFor(() => expect(switchTenant).toHaveBeenCalledWith("t9"));
    const accept = fetchMock.mock.calls.find(([url]) => url.endsWith("/accept"))!;
    expect(JSON.parse(accept[1].body)).toEqual({ token: "tok" });
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/home"));
  });

  it("AC5 — a refused accept shows the server's message and does not switch", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/accept")
        ? new Response(
            JSON.stringify({
              error: { code: "FORBIDDEN", message: "Wrong email", requestId: "r" },
            }),
            { status: 403 },
          )
        : ok({ workspaceName: "Harbour Boats", role: "member" }),
    );
    render(<InviteLanding token="tok" />);

    await user.click(await screen.findByRole("button", { name: "Join" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Wrong email");
    expect(switchTenant).not.toHaveBeenCalled();
  });

  it("AC5 — an invalid token shows one neutral message", async () => {
    fetchMock.mockResolvedValue(notFound());
    render(<InviteLanding token="bad" />);

    expect(
      await screen.findByText("This invite link isn't valid any more."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Join" })).not.toBeInTheDocument();
  });

  it("AC6 — logged out, Log in and Create account both carry the token", async () => {
    status = "unauthenticated";
    fetchMock.mockResolvedValue(ok({ workspaceName: "Harbour Boats", role: "member" }));
    render(<InviteLanding token="tok" />);

    expect(await screen.findByRole("link", { name: "Log in" })).toHaveAttribute(
      "href",
      "/login?redirect=%2Finvite%2Ftok",
    );
    expect(screen.getByRole("link", { name: "Create account" })).toHaveAttribute(
      "href",
      "/signup?invite=tok",
    );
    expect(screen.queryByRole("button", { name: "Join" })).not.toBeInTheDocument();
  });
});
