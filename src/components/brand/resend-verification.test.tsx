/**
 * The resend offer: it posts the address it was given (or the one typed in),
 * and its confirmation never claims the account exists.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResendVerification } from "./resend-verification";

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const posted = () => JSON.parse(fetchMock.mock.calls[0][1].body);

describe("ResendVerification", () => {
  it("resends to the known address with one click, and confirms conditionally", async () => {
    render(<ResendVerification email="ada@example.test" />);
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: /resend/i }));

    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/auth/resend-verification");
    expect(posted()).toEqual({ email: "ada@example.test" });
    expect(await screen.findByRole("status")).toHaveTextContent(/if that account still needs/i);
  });

  it("asks for the address when it has none", async () => {
    const user = userEvent.setup();
    render(<ResendVerification />);
    await user.type(screen.getByLabelText("Email"), " grace@example.test ");
    await user.click(screen.getByRole("button", { name: /resend/i }));
    expect(posted()).toEqual({ email: "grace@example.test" });
  });

  it("shows the server's reason when it refuses", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "RATE_LIMITED", message: "Too many requests", requestId: "r" },
        }),
        { status: 429 },
      ),
    );
    render(<ResendVerification email="ada@example.test" />);
    await userEvent.setup().click(screen.getByRole("button", { name: /resend/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/too many requests/i);
  });
});
