import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScrollbackMessage } from "../lib/api";
import { channelKey } from "../lib/channelKey";
import { appendToScrollback } from "../lib/scrollback";
import { closeServiceModal, openServiceModal } from "../lib/serviceModal";
import { SERVER_WINDOW_NAME } from "../lib/windowKinds";
import ServiceModal from "../ServiceModal";

// #290 — the services console modal. Body is a notice-mirror derived from the
// $server scrollback (where the server routes services-sender NOTICEs),
// filtered to THIS service AND to notices that arrived since the modal opened
// (id > sinceId). Nick is stripped per line (service name lives in the title);
// the `>` prompt sends raw commands to the service via compose.sendBodyLines.

// The `>` prompt is the only outbound path; stub it so the component test
// stays a pure render/behaviour test (no token/api/WS).
vi.mock("../lib/compose", () => ({
  sendBodyLines: vi.fn().mockResolvedValue(undefined),
}));

const notice = (slug: string, id: number, sender: string, body: string): ScrollbackMessage => ({
  id,
  network: slug,
  channel: SERVER_WINDOW_NAME,
  server_time: id,
  kind: "notice",
  sender,
  body,
  meta: {},
});

// Each test uses a distinct slug so the $server scrollback singleton stays
// isolated across cases (no cross-test id/high-water-mark bleed).
const seed = (slug: string, m: ScrollbackMessage): void =>
  appendToScrollback(channelKey(slug, SERVER_WINDOW_NAME), m);

describe("ServiceModal (#290)", () => {
  afterEach(() => {
    closeServiceModal();
    vi.clearAllMocks();
  });

  it("shows nothing when the modal is closed", () => {
    render(() => <ServiceModal />);
    expect(screen.queryByTestId("service-modal")).toBeNull();
  });

  it("titles the modal by the service and mirrors its since-open notices, nick stripped", () => {
    const slug = "svc-title";
    seed(slug, notice(slug, 10, "NickServ", "stale line from a past session"));
    openServiceModal(slug, "NickServ"); // sinceId = 10
    seed(slug, notice(slug, 11, "NickServ", "you are now identified for account foo"));
    render(() => <ServiceModal />);

    const modal = screen.getByTestId("service-modal");
    // The service name titles the modal (not repeated per line).
    expect(modal.querySelector(".service-modal-header h2")?.textContent).toContain("NickServ");

    const lines = screen.getAllByTestId("service-modal-line");
    const texts = lines.map((l) => l.textContent ?? "");
    // The while-open notice renders...
    expect(texts.some((t) => t.includes("you are now identified for account foo"))).toBe(true);
    // ...nick stripped: each line shows ONLY the body, never "<NickServ> ..."
    // or "NickServ: ...".
    for (const l of lines) {
      expect(l.textContent).not.toContain("NickServ");
    }
    // ...and the pre-open notice is NOT mirrored (capture only while open).
    expect(texts.some((t) => t.includes("stale line from a past session"))).toBe(false);
  });

  it("filters to THIS service — a different service's notice is not shown", () => {
    const slug = "svc-filter";
    openServiceModal(slug, "NickServ"); // sinceId = 0
    seed(slug, notice(slug, 5, "ChanServ", "this belongs to chanserv"));
    seed(slug, notice(slug, 6, "NickServ", "this belongs to nickserv"));
    render(() => <ServiceModal />);

    const texts = screen.getAllByTestId("service-modal-line").map((l) => l.textContent ?? "");
    expect(texts.some((t) => t.includes("this belongs to nickserv"))).toBe(true);
    expect(texts.some((t) => t.includes("this belongs to chanserv"))).toBe(false);
  });

  it("renders mIRC formatting in notice lines, never raw control bytes", () => {
    const slug = "svc-mirc";
    openServiceModal(slug, "NickServ");
    seed(slug, notice(slug, 7, "NickServ", "\x02bold\x02 and \x1funderlined\x1f"));
    render(() => <ServiceModal />);

    const modal = screen.getByTestId("service-modal");
    expect(modal.querySelector(".scrollback-mirc-bold")).not.toBeNull();
    expect(modal.querySelector(".scrollback-mirc-underline")).not.toBeNull();
    for (const byte of ["\x02", "\x1f"]) {
      expect(modal.textContent).not.toContain(byte);
    }
  });

  it("the `>` prompt sends the typed line to the service via sendBodyLines and clears on success", async () => {
    const slug = "svc-prompt";
    openServiceModal(slug, "NickServ");
    render(() => <ServiceModal />);
    const compose = await import("../lib/compose");

    const input = screen.getByTestId("service-modal-input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "ghost oldnick s3cret" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(compose.sendBodyLines).toHaveBeenCalledWith(
      slug,
      "NickServ",
      "ghost oldnick s3cret",
      false,
    );
    // Draft clears only AFTER the send resolves (not optimistically).
    await waitFor(() => expect(input.value).toBe(""));
  });

  it("preserves the (credential-bearing) draft and surfaces an inline error when the send fails", async () => {
    const slug = "svc-fail";
    openServiceModal(slug, "NickServ");
    render(() => <ServiceModal />);
    const compose = await import("../lib/compose");
    vi.mocked(compose.sendBodyLines).mockRejectedValueOnce(new Error("boom"));

    const input = screen.getByTestId("service-modal-input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "identify hunter2" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // The failure surfaces inline (not swallowed to the console)...
    const err = await screen.findByTestId("service-modal-prompt-error");
    expect((err.textContent ?? "").length).toBeGreaterThan(0);
    // ...and the typed line is PRESERVED so the operator can retry without
    // re-typing a password-bearing command.
    expect(input.value).toBe("identify hunter2");
  });

  it("does not send an empty / whitespace-only prompt line", async () => {
    const slug = "svc-empty";
    openServiceModal(slug, "NickServ");
    render(() => <ServiceModal />);
    const compose = await import("../lib/compose");

    const input = screen.getByTestId("service-modal-input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(compose.sendBodyLines).not.toHaveBeenCalled();
  });

  it("closes on the × button", () => {
    const slug = "svc-close";
    openServiceModal(slug, "NickServ");
    render(() => <ServiceModal />);
    expect(screen.queryByTestId("service-modal")).not.toBeNull();

    fireEvent.click(screen.getByLabelText("close"));
    expect(screen.queryByTestId("service-modal")).toBeNull();
  });
});
