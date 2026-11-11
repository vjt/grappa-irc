import { createEffect, createSignal, untrack } from "solid-js";
import type { ScrollbackMessage } from "./api";
import { channelKey } from "./channelKey";
import { getFontSizePx } from "./fontSize";
import { identityScopedStore } from "./identityScopedStore";
import { moduleRoot } from "./moduleRoot";
import { lastLiveArrival, scrollbackByChannel } from "./scrollback";
import { selectedChannel } from "./selection";
import { isMobile } from "./theme";
import { SERVER_WINDOW_NAME } from "./windowKinds";

// issue 2625 — the `$server` peek: on a phone, the `$server` lines that arrive
// after a command, shown in a card over the window the command was typed in,
// so reading a services reply no longer means leaving the window and coming
// back (vjt's request). While the card is up, every further line `$server`
// receives joins it, so a run of commands reads as one session.
//
// ## A VIEW, never a copy
//
// The lines stay in `$server` and stay there unread or read exactly as before:
// the card is a filtered live view over the scrollback store (`id > sinceId`),
// the verb `serviceModal.ts` (#290) already uses for the services console. No
// buffer of its own, nothing the server has to know about, no wire.
//
// ## Which lines: every `$server` line once the card is up; a line within
// REPLY_WINDOW_MS of a command opens it
//
// cic never parses IRC, and nothing correlates a reply with the command that
// caused it — bahamut has no labeled-response, and the server routes what it
// does recognise (WHOIS, WHO, LIST, the #127 info family, CTCP replies) to
// surfaces of their own BEFORE anything reaches `$server`. What is left in
// `$server` after a command is therefore the residue those surfaces did not
// take: services NOTICEs, error numerics, server NOTICEs. So the rule is time,
// not content: a command ARMS the peek, and the first `$server` line to arrive
// LIVE inside the window opens it. Once open it shows everything `$server`
// receives from that line on until it is dismissed, which is what makes the
// second command's output append.
//
// LIVE, because a page is not a reply. The reconnect refresh and a first load
// bring rows the server already held when the command was typed, and the
// high-water mark cannot tell them apart when `$server` was never loaded this
// session (it is 0). A reply is stored after the command reaches the server,
// so it reaches this client on the WS (`lastLiveArrival`), and every backlog
// row is older than it: the card starts AT the first live line, so a page
// that lands later, in either order, stays out of it.
//
// A command is every dispatched slash verb except what is SAID (plain text and
// `/me`, the issue 2536 split): conversation has no reply in `$server`. Bare
// `/ns` (the services console) does not arm either — the console already
// shows those lines, in a modal over this card.
//
// ## Only where it fits, per DEVICE
//
// The card opens only on the mobile layout and only when the screen, at the
// user's font size, holds SERVER_PEEK_MIN_COLS columns and SERVER_PEEK_MIN_ROWS
// rows of text (`serverPeekFits`). The question is asked again whenever the
// answer can change under a card already up — the layout, a resize (a
// rotation is one), the opt-out — and a no closes it. The font size is not
// on that list: it is not a signal, so a size picked while the card is up is
// not asked about until the next resize.
//
// The opt-out lives in this device's localStorage, like the command menu
// (issue 2584, vjt's ruling Q1): whether a card fits over the window is a
// question about the screen, and a phone and a desktop on one account answer
// it differently.

/**
 * How long after a command the first `$server` line still counts as its
 * reply. A services round trip on a healthy link is well under a second; ten
 * covers a lagged one without letting an unrelated server NOTICE that happens
 * along a minute later open a card nobody asked for. A choice, not a
 * measurement: nothing on the agent's side can time Azzurra's services.
 */
export const SERVER_PEEK_REPLY_WINDOW_MS = 10_000;

/**
 * The narrowest screen, in columns of text at the user's font size, the card
 * opens on. A `$server` line spends 20 columns before its body starts
 * (`HH:MM:SS ` plus `-NickServ- `), so 36 leaves 16 for the body; under that
 * a services sentence breaks into a tower of short rows and the card shows
 * one reply at a time. On the e2e phones this lets the presets up to XL
 * through and stops XXL (see `serverPeekFits`' tests for the table).
 */
export const SERVER_PEEK_MIN_COLS = 36;

/**
 * The shortest screen, in rows of text, the card opens on. The card takes at
 * most 40% of the visible height (`.server-peek` in default.css), so twelve
 * rows leave it room for a header and four lines. Portrait phones never come
 * near it; it is a short landscape screen at a large font that it stops.
 */
export const SERVER_PEEK_MIN_ROWS = 12;

// The two metrics a font size turns into, mirrored from the theme rather than
// read off it (the same literal-in-CSS caveat as the breakpoints in theme.ts):
// `--line-height` on `:root` in default.css, and the advance width every
// bundled monospace face shares to within a few percent (0.6em).
const LINE_HEIGHT = 1.4;
const CHAR_ADVANCE_EM = 0.6;

/**
 * Whether a `widthPx` x `heightPx` screen holds the card at `fontPx`: at
 * least SERVER_PEEK_MIN_COLS columns and SERVER_PEEK_MIN_ROWS rows of text.
 */
export function serverPeekFits(widthPx: number, heightPx: number, fontPx: number): boolean {
  const cols = widthPx / (fontPx * CHAR_ADVANCE_EM);
  const rows = heightPx / (fontPx * LINE_HEIGHT);
  return cols >= SERVER_PEEK_MIN_COLS && rows >= SERVER_PEEK_MIN_ROWS;
}

// ---------------------------------------------------------------------------
// The per-device opt-out. ON by default: an opt-OUT, as the request put it
// ("non è utile a tutti"). A stored value this bundle cannot read falls back
// to the default, never to off (the commandMenu.ts rule).

const STORAGE_KEY = "cicchetto.serverPeek";
const DEFAULT_ENABLED = true;

function readStored(): boolean {
  const v = localStorage.getItem(STORAGE_KEY);
  if (v === "true") return true;
  if (v === "false") return false;
  return DEFAULT_ENABLED;
}

// Identity-agnostic, like every per-device preference: no reset on logout.
const pref = moduleRoot(() => {
  const [enabled, setEnabled] = createSignal<boolean>(readStored());
  return { enabled, setEnabled };
});

// A tick per window resize, so the fit below is re-read when the screen turns
// or a window is dragged: `innerWidth` / `innerHeight` are not signals.
const resizes = moduleRoot(() => {
  const [count, setCount] = createSignal(0);
  window.addEventListener("resize", () => setCount((n) => n + 1));
  return count;
});

// Whether this device, as it stands now, takes the card at all.
const allowed = (): boolean => {
  resizes();
  return (
    pref.enabled() &&
    isMobile() &&
    serverPeekFits(window.innerWidth, window.innerHeight, getFontSizePx())
  );
};

// ---------------------------------------------------------------------------
// The peek itself. `armed` waits for the first reply line; `open` is the view.
// One at a time, like the services console: a command on another network
// re-arms there and the old card goes.

type LiveArrival = ReturnType<typeof lastLiveArrival>;

type PeekState =
  | {
      phase: "armed";
      networkSlug: string;
      sinceId: number;
      armedAt: number;
      // The live arrival already there when the command was typed: the
      // event is the last one, not a fresh one, so it must not count.
      seen: LiveArrival;
    }
  | { phase: "open"; networkSlug: string; sinceId: number };

const serverRows = (networkSlug: string): readonly ScrollbackMessage[] =>
  scrollbackByChannel()[channelKey(networkSlug, SERVER_WINDOW_NAME)] ?? [];

const peek = identityScopedStore((onIdentityChange) => {
  const [state, setState] = createSignal<PeekState | null>(null);
  onIdentityChange(() => setState(null));

  // The screen stopped holding the card, or the device opted out: an open or
  // armed card goes at once, not at the next command, and does not come back
  // when the screen does.
  createEffect(() => {
    if (!allowed()) setState(null);
  });

  // The first LIVE `$server` line past the mark opens the card if it came
  // inside the window and disarms it otherwise, and the card starts at that
  // line. A page never gets here. The arrivals are read only while armed, so
  // nothing here runs per line once the peek is open or idle.
  createEffect(() => {
    const st = state();
    if (st === null || st.phase !== "armed") return;
    const arrival = lastLiveArrival();
    if (arrival === null || arrival === st.seen) return;
    if (arrival.key !== channelKey(st.networkSlug, SERVER_WINDOW_NAME)) return;
    if (arrival.id <= st.sinceId) return;
    const inWindow = Date.now() - st.armedAt <= SERVER_PEEK_REPLY_WINDOW_MS;
    setState(
      inWindow ? { phase: "open", networkSlug: st.networkSlug, sinceId: arrival.id - 1 } : null,
    );
  });

  // Opening that network's `$server` window is reading what the card shows,
  // so the card goes; coming back to the channel does not bring it back.
  createEffect(() => {
    const st = state();
    if (st === null || st.phase !== "open") return;
    const sel = selectedChannel();
    if (sel?.networkSlug === st.networkSlug && sel.channelName === SERVER_WINDOW_NAME) {
      setState(null);
    }
  });

  // Called by compose for a command, BEFORE it is sent: the mark has to be
  // taken before the reply can exist (the #1518 ordering the services console
  // follows). A command while the card is open on its network changes
  // nothing — the card already shows what comes next.
  const arm = (networkSlug: string): void => {
    if (!allowed()) return;
    const st = state();
    if (st !== null && st.phase === "open" && st.networkSlug === networkSlug) return;
    const sinceId = serverRows(networkSlug).reduce((max, m) => (m.id > max ? m.id : max), 0);
    setState({
      phase: "armed",
      networkSlug,
      sinceId,
      armedAt: Date.now(),
      seen: untrack(lastLiveArrival),
    });
  };

  const close = (): void => {
    setState(null);
  };

  // What the card shows on `networkSlug`'s windows: nothing unless it is open
  // there. Returns a fresh array of the store's own message objects, so a
  // ref-keyed `<For>` keeps its rows across appends.
  const rows = (networkSlug: string): readonly ScrollbackMessage[] => {
    const st = state();
    if (st === null || st.phase !== "open" || st.networkSlug !== networkSlug) return [];
    return serverRows(networkSlug).filter((m) => m.id > st.sinceId);
  };

  return { arm, close, rows };
});

export const armServerPeek = peek.arm;
export const closeServerPeek = peek.close;
export const serverPeekRows = peek.rows;

export function getServerPeekEnabled(): boolean {
  return pref.enabled();
}

// Turning it off takes an open card away too (the store's `allowed` effect).
export function setServerPeekEnabled(on: boolean): void {
  localStorage.setItem(STORAGE_KEY, on ? "true" : "false");
  pref.setEnabled(on);
}
