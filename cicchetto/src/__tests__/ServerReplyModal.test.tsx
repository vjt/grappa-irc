import { fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerReply, ServerReplySource } from "../lib/api";
import { setSelectedChannel } from "../lib/selection";
import { dismissServerReplyModal, setServerReply } from "../lib/serverReplyModal";
import ServerReplyModal from "../ServerReplyModal";

const SLUG = "azzurra";

const reply = (source: ServerReplySource, lines: string[]): ServerReply => ({
  network: SLUG,
  source,
  lines,
});

const focusNetwork = (): void =>
  setSelectedChannel({ networkSlug: SLUG, channelName: "#bofh", kind: "channel" });

describe("ServerReplyModal (#127)", () => {
  afterEach(() => {
    dismissServerReplyModal(SLUG);
    setSelectedChannel(null);
  });

  it("renders the source title, the reply lines, and the line-count footer", () => {
    focusNetwork();
    setServerReply(SLUG, reply("motd", ["- Welcome to Azzurra -", "Be excellent to each other"]));
    render(() => <ServerReplyModal />);

    const modal = screen.getByTestId("server-reply-modal");
    expect(modal.getAttribute("data-source")).toBe("motd");
    // source → human title mapping lives in the component (server sends no strings)
    expect(modal.textContent).toContain("Message of the Day");
    expect(modal.textContent).toContain("- Welcome to Azzurra -");
    expect(modal.textContent).toContain("Be excellent to each other");
    expect(modal.textContent).toContain("2 lines");
    expect(screen.getAllByTestId("server-reply-modal-line")).toHaveLength(2);
  });

  it("titles /info and /version from the typed source", () => {
    focusNetwork();
    setServerReply(SLUG, reply("info", ["grappa test server"]));
    render(() => <ServerReplyModal />);
    const modal = screen.getByTestId("server-reply-modal");
    expect(modal.textContent).toContain("Server Info");
    expect(modal.textContent).toContain("1 line");
  });

  it("closes on the × button (dismisses the store entry)", () => {
    focusNetwork();
    setServerReply(SLUG, reply("version", ["bahamut-2.2.1"]));
    render(() => <ServerReplyModal />);
    expect(screen.queryByTestId("server-reply-modal")).not.toBeNull();

    fireEvent.click(screen.getByLabelText("close"));
    expect(screen.queryByTestId("server-reply-modal")).toBeNull();
  });

  // #175 — MOTD / INFO / VERSION lines are server free-text and carry mIRC
  // control bytes (colored MOTD banners, bold VERSION headers). RED before
  // the fix: `{line}` interpolates the raw string so the control bytes leak
  // into the DOM and no styled span exists (same bug class as the WhoisCard
  // #142 free-text-field leak). The lines must route through MircBody.
  it("renders mIRC formatting in reply lines, never raw control bytes (#175)", () => {
    focusNetwork();
    // \x02 bold, \x0304 red, \x1f underline, \x0f reset — the codes a colored
    // MOTD / VERSION banner carries on the wire.
    setServerReply(
      SLUG,
      reply("motd", ["\x02Welcome\x02 to \x0304Azzurra\x0f", "\x1funderlined\x1f line"]),
    );
    render(() => <ServerReplyModal />);
    const modal = screen.getByTestId("server-reply-modal");

    // The parser splits the formatted runs into styled <span>s — proof the
    // line routed through MircBody, not a raw `{line}` interpolation.
    expect(modal.querySelector(".scrollback-mirc-bold")).not.toBeNull();
    expect(modal.querySelector(".scrollback-mirc-underline")).not.toBeNull();

    // The de-formatted visible text is present...
    expect(modal.textContent).toContain("Welcome");
    expect(modal.textContent).toContain("Azzurra");
    expect(modal.textContent).toContain("underlined");

    // ...and NO raw mIRC control byte leaks into the DOM.
    for (const byte of ["\x02", "\x03", "\x0f", "\x1f"]) {
      expect(modal.textContent).not.toContain(byte);
    }
  });

  it("renders an empty-reply fallback (422 no-MOTD)", () => {
    focusNetwork();
    setServerReply(SLUG, reply("motd", []));
    render(() => <ServerReplyModal />);
    const modal = screen.getByTestId("server-reply-modal");
    expect(modal.textContent).toContain("(no reply)");
    expect(modal.textContent).toContain("0 lines");
  });

  it("shows nothing when no reply exists for the active network", () => {
    focusNetwork();
    render(() => <ServerReplyModal />);
    expect(screen.queryByTestId("server-reply-modal")).toBeNull();
  });
});
