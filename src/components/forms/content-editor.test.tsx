/**
 * Configuring notes and links for customers. The panel's job is to send only
 * what the server accepts — a message with text in it, a link that is a real
 * web address — placed where the business chose.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { FieldLike } from "@/lib/entities/record-values";
import { ContentEditor } from "./content-editor";

const FIELDS: FieldLike[] = [
  { key: "name", label: "Name", type: "text", required: true },
  { key: "date", label: "Date", type: "date" },
];

function renderEditor() {
  const onSave = vi.fn();
  render(<ContentEditor content={[]} fields={FIELDS} busy={false} onSave={onSave} />);
  return { onSave, user: userEvent.setup() };
}

describe("ContentEditor", () => {
  it("adds a message and saves it where it was placed", async () => {
    const { onSave, user } = renderEditor();

    await user.click(screen.getByRole("button", { name: /add a message/i }));
    await user.type(screen.getByLabelText("Heading (optional)"), "Cancellation policy");
    await user.type(screen.getByLabelText("Message"), "  Cancel 24 hours before.  ");
    await user.selectOptions(screen.getByLabelText(/where to show/i), "date");
    await user.click(screen.getByRole("button", { name: "Save notes & links" }));

    expect(onSave).toHaveBeenCalledWith([
      {
        id: expect.stringMatching(/^[a-z0-9]{1,24}$/),
        kind: "notice",
        title: "Cancellation policy",
        body: "Cancel 24 hours before.",
        after: "date",
      },
    ]);
  });

  it("offers the top of the form and every field as a place to show a block", async () => {
    const { user } = renderEditor();
    await user.click(screen.getByRole("button", { name: /add a message/i }));
    const options = Array.from(
      screen.getByLabelText(/where to show/i).querySelectorAll("option"),
    ).map((option) => option.textContent);
    expect(options).toEqual(["At the top of the form", "After “Name”", "After “Date”"]);
  });

  it("refuses to save a link that is not a web address, and says why", async () => {
    const { onSave, user } = renderEditor();

    await user.click(screen.getByRole("button", { name: /add a link/i }));
    await user.type(screen.getByLabelText("Link text"), "Terms");
    await user.type(screen.getByLabelText("Web address"), "javascript:alert(1)");

    expect(screen.getByText(/full web address/)).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Save notes & links" });
    expect(save).toBeDisabled();
    await user.click(save);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("carries the must-agree switch on a link", async () => {
    const { onSave, user } = renderEditor();

    await user.click(screen.getByRole("button", { name: /add a link/i }));
    await user.type(screen.getByLabelText("Link text"), "Terms of hire");
    await user.type(screen.getByLabelText("Web address"), "https://example.com/terms");
    await user.click(screen.getByRole("checkbox", { name: /must tick/i }));
    await user.click(screen.getByRole("button", { name: "Save notes & links" }));

    expect(onSave).toHaveBeenCalledWith([
      expect.objectContaining({
        kind: "link",
        label: "Terms of hire",
        url: "https://example.com/terms",
        requireAgreement: true,
        after: "date",
      }),
    ]);
  });

  it("removes a block", async () => {
    const { onSave, user } = renderEditor();
    await user.click(screen.getByRole("button", { name: /add a message/i }));
    await user.click(screen.getByRole("button", { name: "Remove message 1" }));
    await user.click(screen.getByRole("button", { name: "Save notes & links" }));
    expect(onSave).toHaveBeenCalledWith([]);
  });
});
