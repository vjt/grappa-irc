import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScrollbackMessage } from "../lib/api";
import { channelKey } from "../lib/channelKey";
import { seedFromTest } from "../lib/members";
import { appendToScrollback } from "../lib/scrollback";
import { setSelectedChannel } from "../lib/selection";
import { closeServiceModal, openServiceModal } from "../lib/serviceModal";
import { SERVER_WINDOW_NAME } from "../lib/windowKinds";
import ServiceModal from "../ServiceModal";

// #290 — the services console modal. Body is a notice-mirror derived from the
// $server scrollback (where the server routes services-sender NOTICEs),
// filtered to THIS service AND to notices that arrived since the modal opened
// (id > sinceId). Nick is stripped per line (service name lives in the title);
// the `>` prompt sends raw commands to the service via pipeline.sendBodyLines.

// The `>` prompt is the only outbound path; stub it so the component test
// stays a pure render/behaviour test (no token/api/WS).
vi.mock("../lib/sendPipeline", () => ({
  sendBodyLines: vi.fn().mockResolvedValue(undefined),
}));

const noticeIn = (
  slug: string,
  id: number,
  sender: string,
  channel: string,
  body: string,
): ScrollbackMessage => ({
  id,
  network: slug,
  channel,
  server_time: id,
  kind: "notice",
  sender,
  body,
  meta: {},
});

const notice = (slug: string, id: number, sender: string, body: string): ScrollbackMessage =>
  noticeIn(slug, id, sender, SERVER_WINDOW_NAME, body);

// Each test uses a distinct slug so the $server scrollback singleton stays
// isolated across cases (no cross-test id/high-water-mark bleed).
const seed = (slug: string, m: ScrollbackMessage): void =>
  appendToScrollback(channelKey(slug, SERVER_WINDOW_NAME), m);

// #661 — seed the service's OWN query window, where the server (#400) re-keys
// its arrivals whenever the operator has that window open.
const seedQuery = (slug: string, service: string, m: ScrollbackMessage): void =>
  appendToScrollback(channelKey(slug, service), m);

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

  // #661 — the reported field bug: with a NickServ QUERY WINDOW open, the
  // console looked dead (empty "waiting for NickServ to reply…" forever) while
  // the help wall piled up in the query behind it. Cause: the server's #400
  // rule re-keys a services arrival to that service's query window when one is
  // open, so the reply NOTICEs never reach `$server` — the only window this
  // mirror used to read. The modal is a view over wherever the service's
  // notices land, so it reads both windows; a mid-open close of the query
  // (arrivals switch back to `$server`) keeps rendering for the same reason.
  it("mirrors notices re-keyed to the service's OPEN query window (#400), still capturing only while open", () => {
    const slug = "svc-open-query";
    seedQuery(slug, "NickServ", noticeIn(slug, 20, "NickServ", "NickServ", "stale query line"));
    openServiceModal(slug, "NickServ"); // sinceId = 20 (high-water across both windows)
    seedQuery(
      slug,
      "NickServ",
      noticeIn(slug, 21, "NickServ", "NickServ", "help wall landed in the query"),
    );
    seed(slug, notice(slug, 22, "NickServ", "and this one landed on $server"));
    render(() => <ServiceModal />);

    const texts = screen.getAllByTestId("service-modal-line").map((l) => l.textContent ?? "");
    expect(texts.some((t) => t.includes("help wall landed in the query"))).toBe(true);
    expect(texts.some((t) => t.includes("and this one landed on $server"))).toBe(true);
    expect(texts.some((t) => t.includes("stale query line"))).toBe(false);
    // Merged in id order — the two windows interleave chronologically, they
    // don't render as two concatenated blocks.
    expect(texts.findIndex((t) => t.includes("in the query"))).toBeLessThan(
      texts.findIndex((t) => t.includes("on $server")),
    );
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
    const pipeline = await import("../lib/sendPipeline");

    const input = screen.getByTestId("service-modal-input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "ghost oldnick s3cret" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(pipeline.sendBodyLines).toHaveBeenCalledWith(
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
    const pipeline = await import("../lib/sendPipeline");
    vi.mocked(pipeline.sendBodyLines).mockRejectedValueOnce(new Error("boom"));

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
    const pipeline = await import("../lib/sendPipeline");

    const input = screen.getByTestId("service-modal-input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(pipeline.sendBodyLines).not.toHaveBeenCalled();
  });

  // issue 2375 — the console exists to be typed into: it opens from a bare
  // `/ns`, so the next keystroke belongs to the `>` prompt, not to whatever
  // held focus behind the scrim (the compose box, which the scrim covers).
  it("focuses the `>` prompt when it opens (issue 2375)", async () => {
    const slug = "svc-focus-open";
    render(() => <ServiceModal />);
    openServiceModal(slug, "NickServ");

    const input = await screen.findByTestId("service-modal-input");
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it("re-focuses the prompt when a second service replaces the first (issue 2375)", async () => {
    const slug = "svc-focus-switch";
    render(() => <ServiceModal />);
    openServiceModal(slug, "NickServ");
    const first = await screen.findByTestId("service-modal-input");
    await waitFor(() => expect(document.activeElement).toBe(first));
    first.blur();

    openServiceModal(slug, "ChanServ");
    await waitFor(() =>
      expect(screen.getByTestId("service-modal").getAttribute("data-service")).toBe("ChanServ"),
    );
    const second = screen.getByTestId("service-modal-input");
    await waitFor(() => expect(document.activeElement).toBe(second));
  });

  // issue 2375 — the dialog is `aria-modal`, but Tab used to run native
  // traversal straight out of it: the modal is mounted BEFORE the compose box
  // in Shell's DOM, so focus walked onto the covered page, and a printable key
  // landing on a button there was redirected into the compose box BEHIND the
  // scrim by the irssi auto-focus. Tab now cycles inside the dialog.
  describe("Tab stays inside the dialog (issue 2375)", () => {
    const open = async (slug: string): Promise<{ input: HTMLElement; close: HTMLElement }> => {
      render(() => <ServiceModal />);
      openServiceModal(slug, "NickServ");
      const input = await screen.findByTestId("service-modal-input");
      await waitFor(() => expect(document.activeElement).toBe(input));
      return { input, close: screen.getByLabelText("close") };
    };

    // The prompt is the completion door (below), so Tab there is consumed
    // like at the compose box — even with nothing to complete — and focus
    // never reaches the edge the trap would have to wrap.
    it("Tab on the prompt is consumed and focus stays in the prompt, even with nothing to complete", async () => {
      const { input } = await open("svc-trap-fwd");
      const ev = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      input.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(input);
    });

    it("Shift+Tab from the close button (the first stop) wraps to the prompt", async () => {
      const { input, close } = await open("svc-trap-back");
      close.focus();
      const ev = new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      close.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(input);
    });

    it("Tab between two inner stops is left to the browser", async () => {
      const { close } = await open("svc-trap-inner");
      close.focus();
      const ev = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      close.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
    });
  });

  // issue 2375 item 4 (vjt's ruling, NOT verified on a device): iOS offered
  // Contacts addresses in the QuickType bar over the old `<input type=text>`,
  // and the composer — a `<textarea rows=1>` — never shows it. The prompt
  // takes the composer's shape; whether that silences the AutoFill is for
  // vjt's iPhone on staging to say. A textarea must still behave like the old
  // single-line field: Enter sends, and no line break ever reaches the draft.
  describe("the prompt is a one-row textarea that still behaves single-line (issue 2375)", () => {
    const open = async (slug: string): Promise<HTMLTextAreaElement> => {
      render(() => <ServiceModal />);
      openServiceModal(slug, "NickServ");
      const el = await screen.findByTestId("service-modal-input");
      return el as HTMLTextAreaElement;
    };

    it("renders as <textarea rows=1>", async () => {
      const el = await open("svc-ta-shape");
      expect(el.tagName).toBe("TEXTAREA");
      expect(el.getAttribute("rows")).toBe("1");
    });

    it("Enter sends and is prevented, so no line break is inserted", async () => {
      const pipeline = await import("../lib/sendPipeline");
      const el = await open("svc-ta-enter");
      fireEvent.input(el, { target: { value: "HELP" } });
      const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
      expect(pipeline.sendBodyLines).toHaveBeenCalledWith(
        "svc-ta-enter",
        "NickServ",
        "HELP",
        false,
      );
    });

    it("Shift+Enter sends too — the prompt has no second line to open", async () => {
      const pipeline = await import("../lib/sendPipeline");
      const el = await open("svc-ta-shift-enter");
      fireEvent.input(el, { target: { value: "HELP" } });
      const ev = new KeyboardEvent("keydown", {
        key: "Enter",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      el.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
      expect(pipeline.sendBodyLines).toHaveBeenCalledTimes(1);
    });

    it("an Enter that commits an IME composition does not send", async () => {
      const pipeline = await import("../lib/sendPipeline");
      const el = await open("svc-ta-ime");
      fireEvent.input(el, { target: { value: "にほん" } });
      el.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(pipeline.sendBodyLines).not.toHaveBeenCalled();
    });

    it("a pasted line break becomes a space, so one Enter sends one line", async () => {
      const pipeline = await import("../lib/sendPipeline");
      const el = await open("svc-ta-paste");
      fireEvent.input(el, { target: { value: "INFO\nvjt\r\nall" } });
      expect(el.value).toBe("INFO vjt all");
      fireEvent.keyDown(el, { key: "Enter" });
      expect(pipeline.sendBodyLines).toHaveBeenCalledWith(
        "svc-ta-paste",
        "NickServ",
        "INFO vjt all",
        false,
      );
    });

    // The flattened value can EQUAL the draft already held (a line break
    // pasted over a selected space): the draft signal does not change, so the
    // value binding writes nothing and the field must be corrected by hand.
    it("a line break that flattens back to the current draft is still removed from the field", async () => {
      const el = await open("svc-ta-paste-same");
      fireEvent.input(el, { target: { value: "INFO vjt" } });
      fireEvent.input(el, { target: { value: "INFO\nvjt" } });
      expect(el.value).toBe("INFO vjt");
    });
  });

  // issue 2375 item 2 (vjt's ruling: B) — Tab / Shift+Tab complete nicks and
  // channels in the prompt through the SAME engine as the compose box. The
  // candidates are the members of the window selected behind the modal plus
  // the channels joined on the modal's network; a line-start nick takes no
  // `: ` (the line opens with a command, `INFO vjt`).
  describe("Tab completes nicks and channels in the prompt (issue 2375)", () => {
    const SLUG = "svc-complete";
    const CHAN = "#grappa";

    const open = async (): Promise<HTMLTextAreaElement> => {
      seedFromTest(channelKey(SLUG, CHAN), [
        { nick: "vjt", modes: [] },
        { nick: "vjtbot", modes: [] },
      ]);
      setSelectedChannel({ networkSlug: SLUG, channelName: CHAN, kind: "channel" });
      render(() => <ServiceModal />);
      openServiceModal(SLUG, "NickServ");
      const el = (await screen.findByTestId("service-modal-input")) as HTMLTextAreaElement;
      await waitFor(() => expect(document.activeElement).toBe(el));
      return el;
    };

    const tab = (el: HTMLTextAreaElement, shiftKey: boolean): void => {
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true }),
      );
    };

    const typeAtEnd = (el: HTMLTextAreaElement, value: string): void => {
      fireEvent.input(el, { target: { value } });
      el.setSelectionRange(value.length, value.length);
    };

    afterEach(() => setSelectedChannel(null));

    it("completes a member of the selected window, with a space and no addressee colon", async () => {
      const el = await open();
      typeAtEnd(el, "INFO vj");
      tab(el, false);
      await waitFor(() => expect(el.value).toBe("INFO vjt "));
    });

    it("cycles forward and back like the compose box", async () => {
      const el = await open();
      typeAtEnd(el, "vj");
      tab(el, false);
      await waitFor(() => expect(el.value).toBe("vjt "));
      tab(el, false);
      await waitFor(() => expect(el.value).toBe("vjtbot "));
      tab(el, true);
      await waitFor(() => expect(el.value).toBe("vjt "));
    });

    it("leaves the compose draft of the selected window untouched", async () => {
      const compose = await import("../lib/compose");
      const el = await open();
      typeAtEnd(el, "INFO vj");
      tab(el, false);
      await waitFor(() => expect(el.value).toBe("INFO vjt "));
      expect(compose.getDraft(channelKey(SLUG, CHAN))).toBe("");
    });
  });

  it("closes on the × button", () => {
    const slug = "svc-close";
    openServiceModal(slug, "NickServ");
    render(() => <ServiceModal />);
    expect(screen.queryByTestId("service-modal")).not.toBeNull();

    fireEvent.click(screen.getByLabelText("close"));
    expect(screen.queryByTestId("service-modal")).toBeNull();
  });

  // issue 1982 — the last of the five compose-reachable overlays to still
  // dismiss on a bare click. `serviceModalCommand` calls `openServiceModal`
  // FIRST and only then awaits `sendBodyLines` — an ordering #1518 pinned as
  // load-bearing (the high-water mark must be taken before the POST), so the
  // scrim provably exists before the tap's compat mouse events are dispatched.
  // The cure therefore has to sit on the scrim; moving the `await` ahead of the
  // open would trade this bug for #1518's.
  describe("backdrop dismiss is armed by the press, not by the click (issue 1982)", () => {
    const backdropIn = (container: HTMLElement): HTMLElement => {
      const el = container.querySelector<HTMLElement>(".service-modal-backdrop");
      if (el === null) throw new Error("no service backdrop rendered");
      return el;
    };

    it("ignores a click the backdrop never received a pointerdown for", () => {
      openServiceModal("svc-press-a", "NickServ");
      const { container } = render(() => <ServiceModal />);

      fireEvent.click(backdropIn(container));

      expect(screen.queryByTestId("service-modal")).not.toBeNull();
    });

    it("still dismisses on a press and release that both land on the backdrop", () => {
      openServiceModal("svc-press-b", "NickServ");
      const { container } = render(() => <ServiceModal />);

      const backdrop = backdropIn(container);
      fireEvent.pointerDown(backdrop);
      fireEvent.click(backdrop);

      expect(screen.queryByTestId("service-modal")).toBeNull();
    });

    it("a press that starts INSIDE the dialog does not dismiss on release", () => {
      openServiceModal("svc-press-c", "NickServ");
      const { container } = render(() => <ServiceModal />);

      fireEvent.pointerDown(screen.getByTestId("service-modal"));
      fireEvent.click(backdropIn(container));

      expect(screen.queryByTestId("service-modal")).not.toBeNull();
    });
  });
});
