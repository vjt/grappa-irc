import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScrollbackMessage } from "../lib/api";
import { channelKey } from "../lib/channelKey";
import { SERVER_WINDOW_NAME } from "../lib/windowKinds";

// issue 2625 — the `$server` peek store. A command ARMS it; the first `$server`
// line inside the reply window OPENS it; once open it is a live view over every
// `$server` line past the high-water mark taken at the command, until it is
// closed. Only on the mobile layout, only where the screen holds enough text at
// the user's font size, and never on a device that opted out.
//
// The scrollback store is the REAL one (the peek is a view over it, so a fake
// would test the fake); the form factor and the selection are the two boundary
// sources, mocked as signals so a test can flip them.

// `vi.hoisted` holds the setter so a test can flip the layout under an open
// card; the mock registry outlives `resetModules`, so it is one signal for the
// whole file, put back to mobile in `beforeEach`.
const form = vi.hoisted(() => ({ setMobile: (_mobile: boolean): void => {} }));
vi.mock("../lib/theme", async () => {
  const { createSignal } = await import("solid-js");
  const [isMobile, setMobile] = createSignal(true);
  form.setMobile = (mobile) => void setMobile(mobile);
  return { isMobile, prefersDark: () => false, applyTheme: vi.fn() };
});

// The two page doors a `$server` backlog comes through — the reconnect refresh
// (`listMessagesAfter`) and a first load (`listMessages`) — so a test can land
// a page of rows that existed before the command.
vi.mock(import("../lib/api"), async (importOriginal) => ({
  ...(await importOriginal()),
  listMessages: vi.fn(),
  listMessagesAfter: vi.fn(),
}));

vi.mock("../lib/selection", async () => {
  const { createSignal } = await import("solid-js");
  const [selectedChannel, setSelectedChannel] = createSignal<{
    networkSlug: string;
    channelName: string;
    kind: string;
  } | null>(null);
  return { selectedChannel, setSelectedChannel };
});

const SLUG = "azzurra";
const SERVER = channelKey(SLUG, SERVER_WINDOW_NAME);
const T0 = Date.UTC(2026, 10, 9, 0, 25, 0);

const row = (id: number, body: string, slug = SLUG): ScrollbackMessage => ({
  id,
  network: slug,
  channel: SERVER_WINDOW_NAME,
  server_time: T0,
  kind: "notice",
  sender: "NickServ",
  body,
  meta: {},
});

type Peek = typeof import("../lib/serverPeek");
type Scrollback = typeof import("../lib/scrollback");

const load = async (): Promise<{ peek: Peek; sb: Scrollback }> => ({
  peek: await import("../lib/serverPeek"),
  sb: await import("../lib/scrollback"),
});

const bodies = (rows: readonly ScrollbackMessage[]): (string | null)[] => rows.map((m) => m.body);

// An iPhone 15 in Safari (the e2e `webkit-iphone-15` viewport) at the default
// 14px: 46 columns, 33 rows, well inside the gate.
const phone = () => {
  vi.stubGlobal("innerWidth", 393);
  vi.stubGlobal("innerHeight", 659);
};

describe("serverPeekFits (issue 2625)", () => {
  it("pins the thresholds and the reply window", async () => {
    const { peek } = await load();
    expect(peek.SERVER_PEEK_MIN_COLS).toBe(36);
    expect(peek.SERVER_PEEK_MIN_ROWS).toBe(12);
    expect(peek.SERVER_PEEK_REPLY_WINDOW_MS).toBe(10_000);
  });

  // A 10px font makes both metrics whole numbers (advance 6px, line 14px), so
  // the edges below are the thresholds themselves, not a rounding of them.
  it.each([
    [216, 168, true, "exactly 36 columns and 12 rows"],
    [215.9, 168, false, "one sliver under 36 columns"],
    [216, 167.9, false, "one sliver under 12 rows"],
  ])("at 10px, %spx x %spx fits=%s (%s)", async (w, h, fits) => {
    const { peek } = await load();
    expect(peek.serverPeekFits(w, h, 10)).toBe(fits);
  });

  // The phones the e2e suite drives, at the font presets (fontSize.ts).
  it.each([
    ["iPhone 15, M 14px", 393, 659, 14, true],
    ["iPhone 15, XL 18px (36.4 columns)", 393, 659, 18, true],
    ["iPhone 15, XXL 20px (32.8 columns)", 393, 659, 20, false],
    ["Pixel 7, M 14px", 412, 839, 14, true],
    ["Pixel 7, XXL 20px (34.3 columns)", 412, 839, 20, false],
    ["iPhone 15, 28px ceiling (23.4 columns)", 393, 659, 28, false],
    ["iPhone SE landscape, 22px (12.2 rows)", 667, 375, 22, true],
    ["iPhone SE landscape, 24px (11.2 rows)", 667, 375, 24, false],
  ])("%s → %s", async (_label, w, h, f, fits) => {
    const { peek } = await load();
    expect(peek.serverPeekFits(w as number, h as number, f as number)).toBe(fits);
  });
});

describe("serverPeek store (issue 2625)", () => {
  beforeEach(async () => {
    vi.resetModules();
    localStorage.clear();
    form.setMobile(true);
    phone();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    // `resetModules` leaves the MOCK registry alone, so the selection signal
    // is the same object in every test: a `$server` selected by one test would
    // close the next test's peek the moment it opened.
    (await import("../lib/selection")).setSelectedChannel(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows nothing before any command", async () => {
    const { peek, sb } = await load();
    sb.appendToScrollback(SERVER, row(1, "a server notice nobody asked for"));
    expect(peek.serverPeekRows(SLUG)).toEqual([]);
  });

  it("opens on the first $server line after a command, with only the lines after it", async () => {
    const { peek, sb } = await load();
    sb.appendToScrollback(SERVER, row(41, "an older line"));
    peek.armServerPeek(SLUG);
    expect(peek.serverPeekRows(SLUG)).toEqual([]);

    vi.setSystemTime(T0 + 800);
    sb.appendToScrollback(SERVER, row(42, "Nickname vjt is registered"));

    expect(bodies(peek.serverPeekRows(SLUG))).toEqual(["Nickname vjt is registered"]);
  });

  it("keeps showing every line $server receives while open, so the next command's output appends", async () => {
    const { peek, sb } = await load();
    peek.armServerPeek(SLUG);
    sb.appendToScrollback(SERVER, row(1, "first reply"));
    vi.setSystemTime(T0 + 60_000);
    peek.armServerPeek(SLUG);
    sb.appendToScrollback(SERVER, row(2, "second reply"));
    expect(bodies(peek.serverPeekRows(SLUG))).toEqual(["first reply", "second reply"]);
  });

  it("opens for a line at exactly the end of the reply window", async () => {
    const { peek, sb } = await load();
    peek.armServerPeek(SLUG);
    vi.setSystemTime(T0 + 10_000);
    sb.appendToScrollback(SERVER, row(1, "a slow reply"));
    expect(bodies(peek.serverPeekRows(SLUG))).toEqual(["a slow reply"]);
  });

  it("stays shut for a line one millisecond past the window, and for every line after it", async () => {
    const { peek, sb } = await load();
    peek.armServerPeek(SLUG);
    vi.setSystemTime(T0 + 10_001);
    sb.appendToScrollback(SERVER, row(1, "too late to be a reply"));
    expect(peek.serverPeekRows(SLUG)).toEqual([]);
    sb.appendToScrollback(SERVER, row(2, "and so is this"));
    expect(peek.serverPeekRows(SLUG)).toEqual([]);
  });

  // The line already in `$server` when the command is typed is not its reply:
  // it must not count as the first line past the mark, or the card would open
  // at once, empty, and take whatever came after — however late.
  it("does not count the line already in $server as the reply", async () => {
    const { peek, sb } = await load();
    sb.appendToScrollback(SERVER, row(41, "an older line"));
    peek.armServerPeek(SLUG);
    vi.setSystemTime(T0 + 10_001);
    sb.appendToScrollback(SERVER, row(42, "a notice past the reply window"));
    expect(peek.serverPeekRows(SLUG)).toEqual([]);
  });

  // The same line once `$server`'s rows are gone. The mark rules the last live
  // line out only while `$server` still holds it; after a purge the mark is 0,
  // and what is left to say the line is old is that it arrived before the arm.
  it("does not count the line already in $server as the reply after $server was purged", async () => {
    const { peek, sb } = await load();
    sb.appendToScrollback(SERVER, row(41, "an older line"));
    sb.purgeScrollback(SERVER);
    peek.armServerPeek(SLUG);
    vi.setSystemTime(T0 + 10_001);
    sb.appendToScrollback(SERVER, row(42, "a notice past the reply window"));
    expect(peek.serverPeekRows(SLUG)).toEqual([]);
  });

  // A page is not a reply. The reconnect refresh brings `$server` rows the
  // server already held when the command was typed (a disconnect's worth, or
  // with `$server` never loaded this session, its oldest page from `after=0`);
  // the mark cannot tell them from a reply when `$server` was never loaded,
  // because it is 0 and every one of them is past it.
  it("does not open on backlog a reconnect refresh brings in while armed", async () => {
    const { peek, sb } = await load();
    const api = await import("../lib/api");
    (await import("../lib/auth")).setToken("tok-2625");
    vi.mocked(api.listMessagesAfter).mockResolvedValue([row(5, "MOTD line"), row(6, "Welcome")]);
    peek.armServerPeek(SLUG);

    await sb.refreshScrollback(SLUG, SERVER_WINDOW_NAME);

    // The backlog did land in `$server`; it just is not the command's reply.
    expect(bodies(sb.scrollbackByChannel()[SERVER] ?? [])).toEqual(["MOTD line", "Welcome"]);
    expect(peek.serverPeekRows(SLUG)).toEqual([]);

    vi.setSystemTime(T0 + 800);
    sb.appendToScrollback(SERVER, row(50, "Nickname vjt is registered"));
    expect(bodies(peek.serverPeekRows(SLUG))).toEqual(["Nickname vjt is registered"]);
  });

  it("does not open on the page a first load of $server brings in while armed", async () => {
    const { peek, sb } = await load();
    const api = await import("../lib/api");
    (await import("../lib/auth")).setToken("tok-2625");
    // The first load baselines `$server`'s read cursor to the page's tail.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }),
    );
    vi.mocked(api.listMessages).mockResolvedValue([row(6, "Welcome"), row(5, "MOTD line")]);
    peek.armServerPeek(SLUG);

    await sb.loadInitialScrollback(SLUG, SERVER_WINDOW_NAME);

    expect(bodies(sb.scrollbackByChannel()[SERVER] ?? [])).toEqual(["MOTD line", "Welcome"]);
    expect(peek.serverPeekRows(SLUG)).toEqual([]);
  });

  // The other order of the same race: the refresh asked for its page before
  // the reply arrived (cursor 0, `$server` empty), and the page lands after the
  // card is open. Its rows are older than the reply, so they stay out of it.
  it("keeps backlog that lands after the card opened out of the card", async () => {
    const { peek, sb } = await load();
    const api = await import("../lib/api");
    (await import("../lib/auth")).setToken("tok-2625");
    let land: (rows: ScrollbackMessage[]) => void = () => {};
    vi.mocked(api.listMessagesAfter).mockReturnValue(
      new Promise<ScrollbackMessage[]>((resolve) => {
        land = resolve;
      }),
    );
    peek.armServerPeek(SLUG);
    const refresh = sb.refreshScrollback(SLUG, SERVER_WINDOW_NAME);

    sb.appendToScrollback(SERVER, row(50, "Nickname vjt is registered"));
    land([row(5, "MOTD line"), row(6, "Welcome")]);
    await refresh;

    expect(bodies(sb.scrollbackByChannel()[SERVER] ?? [])).toEqual([
      "MOTD line",
      "Welcome",
      "Nickname vjt is registered",
    ]);
    expect(bodies(peek.serverPeekRows(SLUG))).toEqual(["Nickname vjt is registered"]);
  });

  it("does not arm on the desktop layout", async () => {
    form.setMobile(false);
    const { peek, sb } = await load();
    peek.armServerPeek(SLUG);
    sb.appendToScrollback(SERVER, row(1, "reply"));
    expect(peek.serverPeekRows(SLUG)).toEqual([]);
  });

  it("does not arm where the screen is too small for the font size", async () => {
    localStorage.setItem("cicchetto.fontSize", "28");
    const { peek, sb } = await load();
    peek.armServerPeek(SLUG);
    sb.appendToScrollback(SERVER, row(1, "reply"));
    expect(peek.serverPeekRows(SLUG)).toEqual([]);
  });

  // The width is the COLUMN axis: at XXL an iPhone 15 holds 32.75 columns and
  // 23.5 rows, so it is the columns that refuse it. Read the other way round
  // (659 wide, 393 tall) the same screen would fit, 54.9 by 14.
  it("does not arm where the width holds too few columns, though the height has rows to spare", async () => {
    localStorage.setItem("cicchetto.fontSize", "XXL");
    const { peek, sb } = await load();
    peek.armServerPeek(SLUG);
    sb.appendToScrollback(SERVER, row(1, "reply"));
    expect(peek.serverPeekRows(SLUG)).toEqual([]);
  });

  it("does not arm on a device that opted out", async () => {
    localStorage.setItem("cicchetto.serverPeek", "false");
    const { peek, sb } = await load();
    peek.armServerPeek(SLUG);
    sb.appendToScrollback(SERVER, row(1, "reply"));
    expect(peek.serverPeekRows(SLUG)).toEqual([]);
  });

  it("closes on dismiss, and a later line does not bring it back", async () => {
    const { peek, sb } = await load();
    peek.armServerPeek(SLUG);
    sb.appendToScrollback(SERVER, row(1, "reply"));
    expect(bodies(peek.serverPeekRows(SLUG))).toEqual(["reply"]);
    peek.closeServerPeek();
    expect(peek.serverPeekRows(SLUG)).toEqual([]);
    sb.appendToScrollback(SERVER, row(2, "more of the reply"));
    expect(peek.serverPeekRows(SLUG)).toEqual([]);
  });

  it("closes when that network's $server window is opened, and not for another window", async () => {
    const { peek, sb } = await load();
    const selection = await import("../lib/selection");
    peek.armServerPeek(SLUG);
    sb.appendToScrollback(SERVER, row(1, "reply"));

    selection.setSelectedChannel({ networkSlug: SLUG, channelName: "#grappa", kind: "channel" });
    expect(bodies(peek.serverPeekRows(SLUG))).toEqual(["reply"]);

    // Another network's `$server` does not hold these lines.
    selection.setSelectedChannel({ networkSlug: "libera", channelName: "$server", kind: "server" });
    expect(bodies(peek.serverPeekRows(SLUG))).toEqual(["reply"]);

    selection.setSelectedChannel({ networkSlug: SLUG, channelName: "$server", kind: "server" });
    expect(peek.serverPeekRows(SLUG)).toEqual([]);
  });

  it("closes when the device opts out while it is open", async () => {
    const { peek, sb } = await load();
    peek.armServerPeek(SLUG);
    sb.appendToScrollback(SERVER, row(1, "reply"));
    expect(bodies(peek.serverPeekRows(SLUG))).toEqual(["reply"]);
    peek.setServerPeekEnabled(false);
    expect(peek.serverPeekRows(SLUG)).toEqual([]);
  });

  // The screen is asked again whenever it changes, not only at the command:
  // the card goes when the layout leaves mobile, and it stays gone when the
  // layout comes back (the lines are still in `$server`).
  it("closes when the layout leaves mobile while it is open, and does not come back with it", async () => {
    const { peek, sb } = await load();
    peek.armServerPeek(SLUG);
    sb.appendToScrollback(SERVER, row(1, "reply"));
    expect(bodies(peek.serverPeekRows(SLUG))).toEqual(["reply"]);

    form.setMobile(false);
    expect(peek.serverPeekRows(SLUG)).toEqual([]);
    form.setMobile(true);
    expect(peek.serverPeekRows(SLUG)).toEqual([]);
  });

  it("disarms when the layout leaves mobile before the reply", async () => {
    const { peek, sb } = await load();
    peek.armServerPeek(SLUG);
    form.setMobile(false);
    form.setMobile(true);
    sb.appendToScrollback(SERVER, row(1, "reply"));
    expect(peek.serverPeekRows(SLUG)).toEqual([]);
  });

  // The XXL iPhone 15 of the test above, held the other way first: landscape
  // holds 54.9 columns by 14 rows, so the card opens; turned to portrait it
  // holds 32.75 columns, and the resize that comes with the turn takes it away.
  it("closes when a rotation leaves too few columns for the font size", async () => {
    localStorage.setItem("cicchetto.fontSize", "XXL");
    vi.stubGlobal("innerWidth", 659);
    vi.stubGlobal("innerHeight", 393);
    const { peek, sb } = await load();
    peek.armServerPeek(SLUG);
    sb.appendToScrollback(SERVER, row(1, "reply"));
    expect(bodies(peek.serverPeekRows(SLUG))).toEqual(["reply"]);

    vi.stubGlobal("innerWidth", 393);
    vi.stubGlobal("innerHeight", 659);
    window.dispatchEvent(new Event("resize"));
    expect(peek.serverPeekRows(SLUG)).toEqual([]);
  });

  // The scrollback store empties on logout too, so "no rows right after the
  // logout" holds whether or not the peek forgot itself. What only the peek's
  // own reset prevents is the NEXT account's `$server` lines landing in a card
  // nobody in that session asked for.
  it("forgets an open peek on logout: the next account's $server lines open nothing", async () => {
    const auth = await import("../lib/auth");
    auth.setToken("tok-a");
    const { peek, sb } = await load();
    peek.armServerPeek(SLUG);
    sb.appendToScrollback(SERVER, row(1, "reply"));
    expect(bodies(peek.serverPeekRows(SLUG))).toEqual(["reply"]);
    auth.setToken(null);
    expect(peek.serverPeekRows(SLUG)).toEqual([]);

    auth.setToken("tok-b");
    sb.appendToScrollback(SERVER, row(2, "the next account's server notice"));
    expect(peek.serverPeekRows(SLUG)).toEqual([]);
  });

  it("belongs to the network the command was typed on", async () => {
    const { peek, sb } = await load();
    peek.armServerPeek(SLUG);
    sb.appendToScrollback(channelKey("libera", SERVER_WINDOW_NAME), row(7, "elsewhere", "libera"));
    expect(peek.serverPeekRows("libera")).toEqual([]);
    sb.appendToScrollback(SERVER, row(8, "here"));
    expect(peek.serverPeekRows("libera")).toEqual([]);
    expect(bodies(peek.serverPeekRows(SLUG))).toEqual(["here"]);
  });

  // The live arrival is ONE signal for every window, so while armed the peek
  // sees each line of every channel and query on every network, and only the
  // key check tells a `$server` reply from the rest. The case above cannot
  // show it: a wrong line opening the card there still leaves the real reply
  // inside it. Here nothing that belongs in the card arrives inside the
  // window, so a card opened by the wrong line is the only way to show the
  // late notice.
  it("does not open on a channel line inside the window", async () => {
    const { peek, sb } = await load();
    peek.armServerPeek(SLUG);
    vi.setSystemTime(T0 + 800);
    sb.appendToScrollback(channelKey(SLUG, "#grappa"), {
      ...row(7, "chatter in a channel"),
      channel: "#grappa",
      kind: "privmsg",
      sender: "vjt",
    });
    vi.setSystemTime(T0 + 10_001);
    sb.appendToScrollback(SERVER, row(8, "an unrelated notice past the reply window"));
    expect(peek.serverPeekRows(SLUG)).toEqual([]);
  });

  it("does not open on another network's $server line inside the window", async () => {
    const { peek, sb } = await load();
    peek.armServerPeek(SLUG);
    vi.setSystemTime(T0 + 800);
    sb.appendToScrollback(channelKey("libera", SERVER_WINDOW_NAME), row(7, "elsewhere", "libera"));
    vi.setSystemTime(T0 + 10_001);
    sb.appendToScrollback(SERVER, row(8, "an unrelated notice past the reply window"));
    expect(peek.serverPeekRows(SLUG)).toEqual([]);
  });
});

describe("serverPeek preference (issue 2625)", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it("is on for a device that never set it", async () => {
    const { peek } = await load();
    expect(peek.getServerPeekEnabled()).toBe(true);
  });

  it("a stored value it cannot read falls back to on, never to off", async () => {
    localStorage.setItem("cicchetto.serverPeek", "0");
    const { peek } = await load();
    expect(peek.getServerPeekEnabled()).toBe(true);
  });

  it("turning it off is remembered across a page load", async () => {
    const first = await import("../lib/serverPeek");
    first.setServerPeekEnabled(false);
    expect(localStorage.getItem("cicchetto.serverPeek")).toBe("false");
    vi.resetModules();
    const reloaded = await import("../lib/serverPeek");
    expect(reloaded.getServerPeekEnabled()).toBe(false);
  });
});
