import { fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScrollbackMessage } from "../lib/api";
import { channelKey } from "../lib/channelKey";
import { appendToScrollback } from "../lib/scrollback";
import { armServerPeek, closeServerPeek } from "../lib/serverPeek";
import { SERVER_WINDOW_NAME } from "../lib/windowKinds";
import ServerPeekPanel from "../ServerPeekPanel";

// issue 2625 — the `$server` peek card. It draws the store's rows through the
// line renderer its host hands it (ScrollbackPane passes the one message-line
// renderer, so a `$server` line reads the same in the card as in the window),
// on the windows of the network the command was typed on, and nowhere else.
// The store's own rules (arming, the reply window, the gates) are pinned in
// serverPeek.test.ts; this file pins what the card shows and its ✕.

// jsdom has no matchMedia, so the real theme module would measure DESKTOP and
// the store would never arm.
vi.mock("../lib/theme", () => ({
  isMobile: () => true,
  prefersDark: () => false,
  applyTheme: vi.fn(),
}));

const notice = (slug: string, id: number, body: string): ScrollbackMessage => ({
  id,
  network: slug,
  channel: SERVER_WINDOW_NAME,
  server_time: id,
  kind: "notice",
  sender: "NickServ",
  body,
  meta: {},
});

// The scrollback store is a module singleton: each test takes its own slug so
// one test's rows and marks never reach the next.
const reply = (slug: string, id: number, body: string): void =>
  appendToScrollback(channelKey(slug, SERVER_WINDOW_NAME), notice(slug, id, body));

const line = (m: ScrollbackMessage) => <div data-testid="peek-line">{m.body}</div>;

describe("ServerPeekPanel (issue 2625)", () => {
  beforeEach(() => {
    vi.stubGlobal("innerWidth", 393);
    vi.stubGlobal("innerHeight", 659);
  });

  afterEach(() => {
    closeServerPeek();
    vi.unstubAllGlobals();
  });

  it("draws nothing while no command has been answered", () => {
    render(() => <ServerPeekPanel networkSlug="net-idle" line={line} />);
    reply("net-idle", 1, "an unrelated notice");
    expect(screen.queryByTestId("server-peek")).toBeNull();
  });

  it("draws each reply line through the host's renderer, in order", () => {
    render(() => <ServerPeekPanel networkSlug="net-open" line={line} />);
    armServerPeek("net-open");
    reply("net-open", 1, "Nickname vjt is registered");
    reply("net-open", 2, "Last seen: now");

    expect(screen.getByTestId("server-peek")).toBeInTheDocument();
    expect(screen.getAllByTestId("peek-line").map((el) => el.textContent)).toEqual([
      "Nickname vjt is registered",
      "Last seen: now",
    ]);
  });

  it("goes away on its ✕", () => {
    render(() => <ServerPeekPanel networkSlug="net-close" line={line} />);
    armServerPeek("net-close");
    reply("net-close", 1, "reply");

    fireEvent.click(screen.getByRole("button", { name: "close" }));

    expect(screen.queryByTestId("server-peek")).toBeNull();
  });

  it("is not drawn on another network's window", () => {
    render(() => <ServerPeekPanel networkSlug="net-other" line={line} />);
    armServerPeek("net-mine");
    reply("net-mine", 1, "reply on my network");
    expect(screen.queryByTestId("server-peek")).toBeNull();
  });
});
