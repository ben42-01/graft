/**
 * The record image control.
 *
 * Two behaviours carry the weight: the record must exist before there is
 * anything to own the image (a real constraint of the ownership model, stated
 * rather than hidden), and the three-step upload must never send the app's
 * cookies to the bucket.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImageField } from "./image-field";

const props = {
  entityId: "e1",
  recordId: "r1",
  fieldKey: "photo",
  label: "Photo",
  mediaId: null,
  onChange: vi.fn(),
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The happy path of the three-request upload: ticket, bucket PUT, confirm. */
function stubUpload() {
  // `init` is declared even though the stub ignores it: the assertions read
  // it back off the recorded calls.
  const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://bucket.test")) {
      return Promise.resolve(new Response(null, { status: 200 }));
    }
    if (url.endsWith("/media")) {
      return Promise.resolve(
        jsonResponse({
          data: {
            mediaId: "m1",
            uploadUrl: "https://bucket.test/put",
            contentType: "image/png",
          },
        }),
      );
    }
    return Promise.resolve(jsonResponse({ data: { mediaId: "m1" } }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const pngFile = () => new File(["bytes"], "boat.png", { type: "image/png" });

describe("ImageField", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("explains why there is nothing to upload to on an unsaved record", () => {
    render(<ImageField {...props} recordId={null} />);

    expect(screen.getByText(/Save this record first/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("uploads through the ticket, the bucket and the confirm, in that order", async () => {
    const user = userEvent.setup();
    const fetchMock = stubUpload();
    const onChange = vi.fn();

    render(<ImageField {...props} onChange={onChange} />);
    await user.upload(screen.getByLabelText("Upload Photo"), pngFile());

    await waitFor(() => expect(onChange).toHaveBeenCalledWith("m1"));

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls[0]).toBe("/api/v1/entities/e1/records/r1/media");
    expect(urls[1]).toBe("https://bucket.test/put");
    expect(urls[2]).toBe("/api/v1/entities/e1/records/r1/media/m1");
  });

  it("never sends the app's cookies to the bucket", async () => {
    const user = userEvent.setup();
    const fetchMock = stubUpload();

    render(<ImageField {...props} />);
    await user.upload(screen.getByLabelText("Upload Photo"), pngFile());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ credentials: "omit" });
    // …and the field key travels with both of our own requests.
    expect(String(fetchMock.mock.calls[0]![1]?.body)).toContain("photo");
    expect(String(fetchMock.mock.calls[2]![1]?.body)).toContain("photo");
  });

  it("refuses an oversized file before it reaches the network", async () => {
    const user = userEvent.setup();
    const fetchMock = stubUpload();

    render(<ImageField {...props} />);
    const huge = new File([new Uint8Array(6 * 1024 * 1024)], "huge.png", {
      type: "image/png",
    });
    await user.upload(screen.getByLabelText("Upload Photo"), huge);

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/larger than 5 MB/),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces the server's own message when the upload is refused", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({ error: { code: "QUOTA_EXCEEDED", message: "No storage left." } }, 403),
        ),
      ),
    );

    render(<ImageField {...props} />);
    await user.upload(screen.getByLabelText("Upload Photo"), pngFile());

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("No storage left."),
    );
  });

  it("previews an existing image through the authenticated byte route", () => {
    render(<ImageField {...props} mediaId="m9" />);

    // Not /public/media: a record's photo is visible to the business that owns
    // it whether or not any form is publishing it.
    expect(screen.getByRole("img", { name: "Photo" })).toHaveAttribute(
      "src",
      "/api/v1/media/m9",
    );
    expect(screen.getByRole("button", { name: "Replace" })).toBeInTheDocument();
  });

  it("removes the image, naming the field on the way out", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(jsonResponse({ data: { removed: true } })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onChange = vi.fn();

    render(<ImageField {...props} mediaId="m9" onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: /Remove/ }));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(null));
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "/api/v1/entities/e1/records/r1/media/m9?fieldKey=photo",
    );
  });
});
