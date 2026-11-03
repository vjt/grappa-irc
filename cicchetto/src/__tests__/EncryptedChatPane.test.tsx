import { Route, Router } from "@solidjs/router";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import { channelKey } from "../lib/channelKey";
import { setDraft } from "../lib/compose";
import { acceptConfirm, confirmRequest, dismissConfirm } from "../lib/confirmDialog";
import type { Chat, ChatRow, IdentityCheck } from "../lib/e2e/chatStore";
import type { PeerTrust } from "../lib/e2e/client";
import type { SasView } from "../lib/e2e/sas";
import { SAS_EMOJI } from "../lib/e2e/sasEmoji";
import { friendlyApiError } from "../lib/friendlyApiError";
import { pressAndClick } from "./helpers/pointerEvents";
import { ruleBody, themeCss } from "./helpers/themeCss";

// issue 2430 — the encrypted query window: the pane, and since issue 2485 its
// technical half in the right rail (EncryptedRail), rendered side by side as
// Shell mounts them. The chat glue (lib/encryptedChats) is the boundary: its
// reads are signals here and its verbs are spies, so these tests pin what the
// window shows where, and which verb each control reaches. `trustOf`,
// `openAlarm` and `unreadableStep` stay the real ones: the badge and the step are their answers,
// not copies of them, as do the pairing link helpers (`lib/e2e/pairing.ts`).
// A key is a master.

const KEY = "J2bCqN5ukKUq1qDNgzWbn9GZ7xjzM2bA0f9yqkvq0Ss";
const OWN = "7hPz0kdkCq0cH1L2oW9i3l0gq3uM8V8vxa5w8Kq2yYk";

const [chat, setChat] = createSignal<Chat | undefined>(undefined);
const [rows, setRows] = createSignal<ChatRow[] | undefined>(undefined);
const [trust, setTrust] = createSignal<PeerTrust | null>(null);
const [own, setOwn] = createSignal<string | undefined>(undefined);
const [visible, setVisible] = createSignal(true);
const [sas, setSas] = createSignal<SasView | null>(null);
const [elsewhere, setElsewhere] = createSignal(false);

const loadEncryptedChat = vi.hoisted(() => vi.fn());
const readEncryptedChat = vi.hoisted(() => vi.fn());
const sendEncrypted = vi.hoisted(() => vi.fn());
const pinEncryptedKey = vi.hoisted(() => vi.fn());
const verifyEncrypted = vi.hoisted(() => vi.fn());
const deleteEncryptedChat = vi.hoisted(() => vi.fn());
const replaceEncryptedIdentity = vi.hoisted(() => vi.fn());
const rekeyEncrypted = vi.hoisted(() => vi.fn());
const copyText = vi.hoisted(() => vi.fn());
const loadDocument = vi.hoisted(() => vi.fn());
const holdsMasterHere = vi.hoisted(() => vi.fn());
const openQueryWindowState = vi.hoisted(() => vi.fn());
const sendCtcpQuery = vi.hoisted(() => vi.fn(async () => undefined));
const loadMore = vi.hoisted(() => vi.fn(async () => undefined));
const loadNewer = vi.hoisted(() => vi.fn(async () => undefined));
const refreshScrollback = vi.hoisted(() => vi.fn(async () => undefined));
const panel = vi.hoisted(() => ({
  onClose: null as null | (() => void),
  mounted: 0,
  unmounted: 0,
}));

vi.mock("../lib/encryptedChats", async (importOriginal) => ({
  trustOf: (await importOriginal<typeof import("../lib/encryptedChats")>()).trustOf,
  openAlarm: (await importOriginal<typeof import("../lib/encryptedChats")>()).openAlarm,
  unreadableStep: (await importOriginal<typeof import("../lib/encryptedChats")>()).unreadableStep,
  encryptedChat: () => chat(),
  encryptedRows: () => rows(),
  encryptedTrust: () => trust(),
  encryptedSas: () => sas(),
  ownKey: () => own(),
  identityElsewhere: () => elsewhere(),
  replaceEncryptedIdentity,
  loadEncryptedChat,
  readEncryptedChat,
  sendEncrypted,
  pinEncryptedKey,
  verifyEncrypted,
  deleteEncryptedChat,
  rekeyEncrypted,
  pairedHere: vi.fn(),
  // What the scrollback pane and the compose store follow (issue 2512); the
  // tests that read them drive them through encryptedChats' own suite.
  encryptedSendSubmitted: () => null,
  lastEncryptedSend: () => null,
  encryptedChatDeleted: () => null,
}));
// Whether this browser holds the network's master, and the add-a-device
// panel itself (its own tests drive it): the pane decides only what to offer.
vi.mock("../lib/e2e/pairingDeps", () => ({ holdsMasterHere, pairingDeps: vi.fn() }));
vi.mock("../AddDevicePanel", async () => {
  const { onCleanup } = await import("solid-js");
  return {
    default: (props: { onClose: () => void }) => {
      panel.onClose = props.onClose;
      panel.mounted += 1;
      onCleanup(() => {
        panel.unmounted += 1;
      });
      const el = document.createElement("div");
      el.dataset.testid = "add-device-panel";
      return el;
    },
  };
});
vi.mock("../lib/documentVisibility", () => ({ isDocumentVisible: () => visible() }));
// A nick's click opens its query (issue 2498): the network resolves, and the
// query door is a spy, so a test reads which nick it opened, if any. The
// network is a connected one, as the scrollback pane and the compose box
// (issue 2512) find it in the list.
vi.mock("../lib/networks", async (importOriginal) => {
  const azzurra = {
    kind: "user" as const,
    id: 7,
    slug: "azzurra",
    nick: "alice",
    connection_state: "connected" as const,
    connection_state_reason: null,
    connection_state_changed_at: null,
    inserted_at: "",
    updated_at: "",
  };
  return {
    ...(await importOriginal<typeof import("../lib/networks")>()),
    networks: () => [azzurra],
    networkBySlug: (slug: string) => (slug === "azzurra" ? azzurra : undefined),
    networkIdBySlug: () => 7,
  };
});
vi.mock("../lib/queryWindows", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/queryWindows")>()),
  canonicalQueryNick: (_networkId: number, nick: string) => nick,
  openQueryWindowState,
}));
vi.mock("../lib/clipboard", () => ({ copyText }));
// A nick menu's CTCP verb (issue 2512): a boundary spy, so a test reads which
// window it answers in.
vi.mock("../lib/ctcpQuery", () => ({ sendCtcpQuery }));
// grappa's paging verbs (issue 2512): spies, so a test reads that the window
// pages nothing from grappa's scrollback.
vi.mock("../lib/scrollback", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/scrollback")>()),
  loadMore,
  loadNewer,
  refreshScrollback,
}));
// jsdom implements no document navigation (and makes `location.assign`
// unforgeable): the one-line seam is mocked, and a test below loads the URL
// it was handed the way the browser would, as a fresh document.
vi.mock("../lib/documentNavigation", () => ({ loadDocument }));

const { default: EncryptedChatPane } = await import("../EncryptedChatPane");
const { default: EncryptedRail } = await import("../EncryptedRail");
const { default: PairScan } = await import("../PairScan");
const { formatTime } = await import("../ScrollbackPane");

const at = 1_700_000_000_000;

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of [
    loadEncryptedChat,
    readEncryptedChat,
    sendEncrypted,
    copyText,
    verifyEncrypted,
    deleteEncryptedChat,
    replaceEncryptedIdentity,
    rekeyEncrypted,
  ]) {
    fn.mockResolvedValue(undefined);
  }
  pinEncryptedKey.mockResolvedValue("pinned");
  holdsMasterHere.mockResolvedValue(true);
  panel.mounted = 0;
  panel.unmounted = 0;
  setChat({ nick: "Bob", open: true, unread: 0 });
  setRows([]);
  setTrust(null);
  setOwn(OWN);
  setVisible(true);
  setSas(null);
  setElsewhere(false);
  dismissConfirm();
  // The compose store is the app's one (issue 2512): each test starts on an
  // empty draft for the window.
  setDraft(channelKey("azzurra", "$e2e:bob"), "");
});

const Pane = () => (
  <EncryptedChatPane
    networkSlug="azzurra"
    nick="bob"
    ownNick="alice"
    windowsOpener={null}
    railOpener={null}
    onDialogOpen={null}
  />
);

// The window as Shell mounts it on desktop: the pane, and the rail beside it.
const renderPane = () =>
  render(() => (
    <>
      <Pane />
      <EncryptedRail networkSlug="azzurra" nick="bob" />
    </>
  ));

const within = (testId: string) => screen.getByTestId(testId);

// The chat's messages, as the scrollback's lines (issue 2498): each read as
// its kind and the nick it names, and its body.
const lines = () =>
  Array.from(
    screen.getByTestId("e2e-pane").querySelectorAll<HTMLElement>("[data-testid=scrollback-line]"),
  );
const line = (row: HTMLElement) =>
  `${row.dataset.kind} ${row.querySelector(".scrollback-sender")?.textContent}`;
const body = (row: HTMLElement | undefined) => row?.querySelector(".scrollback-body")?.textContent;

// issue 2512 — the window's compose line is the compose box every window has,
// and the scroll is the scrollback pane's.
const composer = () =>
  within("e2e-pane").querySelector("textarea[data-compose-input]") as HTMLTextAreaElement;
const composeShut = () => (within("e2e-pane").querySelector(".e2e-compose") as HTMLElement).inert;
const type = (text: string) => fireEvent.input(composer(), { target: { value: text } });
const enter = () => fireEvent.keyDown(composer(), { key: "Enter" });

describe("EncryptedChatPane", () => {
  it("loads the chat it shows, names the peer as the chat spells it, and composes in the compose box", () => {
    renderPane();
    expect(loadEncryptedChat).toHaveBeenCalledWith("azzurra", "bob");
    expect(within("e2e-pane").querySelector(".e2e-heading")?.textContent).toBe("Bob");
    // The compose box names the window as it was opened, as a query's does.
    expect(composer().getAttribute("placeholder")).toBe("encrypted message to bob");
  });

  it("the trust badge: not verified, then verified once pinned, then an alarm after it", () => {
    renderPane();
    // Read again each time: the badge moves into its button once it is the
    // comparison's door (issue 2507), and out of it again.
    const badge = () => screen.getByTestId("e2e-peer-trust");
    expect(badge().dataset.trust).toBe("unverified");
    expect(badge().textContent).toBe("not verified");

    setTrust({ master: KEY, verified: true, devices: 1 });
    setRows([{ kind: "pinned", id: "p", at, nick: "Bob", ed25519: KEY }]);
    expect(badge().dataset.trust).toBe("verified");
    expect(screen.getByTestId("e2e-rail-trust").dataset.trust).toBe("verified");

    setRows([
      { kind: "pinned", id: "p", at, nick: "Bob", ed25519: KEY },
      { kind: "key_alarm", id: "a", at, nick: "Bob", presented: OWN },
    ]);
    expect(badge().dataset.trust).toBe("alarm");
    expect(badge().textContent).toBe("key changed");
  });

  it("the top bar is verification only: no key, no pin form, no device, no comparison running in it", () => {
    setTrust({ master: KEY, verified: false, devices: 2 });
    setRows([{ kind: "accepted", id: "p", at, nick: "Bob", ed25519: KEY }]);
    renderPane();
    const bar = screen.getByTestId("e2e-pane").querySelector("header") as HTMLElement;

    expect(bar.textContent).not.toContain(KEY);
    expect(bar.textContent).not.toContain(OWN);
    expect(bar.querySelector("input")).toBeNull();
    expect(bar.querySelector("[data-testid=e2e-sas]")).toBeNull();
    // What it does carry: the badge and the chat's two tools.
    expect(bar.querySelector("[data-testid=e2e-peer-trust]")).not.toBeNull();
    expect(bar.querySelector("[data-testid=e2e-search-toggle]")).not.toBeNull();
    expect(bar.querySelector("[data-testid=e2e-delete-chat]")).not.toBeNull();
  });

  // issue 2498 (vjt's ruling): one renderer. The messages are the scrollback's
  // lines, as in any query: the time, `<nick>` with our own nick as the
  // network knows it, the body on the same line. The encryption is the line's
  // decoration (the lock, the delivery state), and a message that cannot be
  // read is the line the scrollback draws for one.
  it("shows the messages as the scrollback's lines, each marked encrypted, and none of the key events the store keeps", () => {
    setTrust({ master: KEY, verified: true, devices: 1 });
    setRows([
      { kind: "in", id: "1", at, nick: "Bob", ed25519: KEY, body: "ciao" },
      { kind: "out", id: "2", at, body: "waiting", state: "queued", reason: null },
      { kind: "out", id: "3", at, body: "done", state: "sent", reason: null },
      { kind: "out", id: "4", at, body: "nope", state: "failed", reason: "rate-limited" },
      { kind: "out", id: "4b", at, body: "early", state: "failed", reason: "no-budget" },
      { kind: "undecryptable", id: "5", at, nick: "Bob" },
      { kind: "key_alarm", id: "6", at, nick: "Bob", presented: OWN },
      { kind: "pinned", id: "7", at, nick: "Bob", ed25519: KEY },
      { kind: "accepted", id: "8", at, nick: "Bob", ed25519: KEY },
      { kind: "sas_asked", id: "9", at, nick: "Bob", by: "you" },
      { kind: "sas_asked", id: "10", at, nick: "Bob", by: "peer" },
      { kind: "sas_cancelled", id: "11", at, nick: "Bob", by: "you", reason: "timeout" },
      { kind: "sas_cancelled", id: "12", at, nick: "Bob", by: "peer", reason: "its own words" },
      { kind: "verified", id: "13", at, nick: "Bob", ed25519: KEY },
    ]);
    renderPane();
    const shown = lines();
    expect(shown.map(line)).toEqual([
      "privmsg <Bob>",
      "privmsg <alice>",
      "privmsg <alice>",
      "privmsg <alice>",
      "privmsg <alice>",
      "server_event Bob",
    ]);
    for (const row of shown) {
      expect(row.querySelector(".scrollback-time")?.textContent).toBe(formatTime(at));
      expect(row.querySelector(".encrypted-marker")).not.toBeNull();
    }
    expect(body(shown[0])).toBe("ciao");
    expect(body(shown[1])).toBe("waiting");
    expect(shown[1]?.textContent).toContain("waiting for keys");
    expect(shown[2]?.querySelector("[data-testid=e2e-row-state]")?.textContent).toBe("");
    expect(shown[3]?.textContent).toContain("not sent: grappa's queue for this peer is full");
    expect(shown[4]?.textContent).toContain(
      "not sent: the network is not connected yet, so it could not be sized",
    );
    expect(shown[5]?.textContent).toContain(
      "Bob sent you 1 encrypted message that cannot be read here",
    );
    // The scrollback pane's own list holds them (issue 2512).
    const list = within("e2e-pane").querySelector("[data-testid=scrollback]") as HTMLElement;
    expect(shown.every((row) => list.contains(row))).toBe(true);
    expect(list.textContent).not.toContain(KEY);
    expect(list.textContent).not.toContain(OWN);
    // The exchange is done (a pinned key, the alarm answered): no step either.
    expect(screen.queryByTestId("e2e-step")).toBeNull();
  });

  // In any query a click on the peer's nick lands in the window already
  // open; here that is this one, never the plaintext query beside it. Any
  // other nick opens its query, as on every line.
  it("a click on the peer's nick stays in the encrypted window; ours opens our query", () => {
    setTrust({ master: KEY, verified: true, devices: 1 });
    setRows([
      { kind: "in", id: "1", at, nick: "Bob", ed25519: KEY, body: "ciao" },
      { kind: "out", id: "2", at, body: "ciao bob", state: "sent", reason: null },
    ]);
    renderPane();
    const [theirs, ours] = lines();
    fireEvent.click(theirs?.querySelector(".scrollback-sender") as HTMLElement);
    expect(openQueryWindowState).not.toHaveBeenCalled();

    fireEvent.click(ours?.querySelector(".scrollback-sender") as HTMLElement);
    expect(openQueryWindowState).toHaveBeenCalledWith(7, "alice", expect.any(String));
  });

  // The window takes no command: anything typed there goes to the peer,
  // encrypted. So a verb from a nick's menu answers in the plain query with
  // the peer, as it would from any query window (issue 2498), never here.
  it("a nick's menu answers in the plain query with the peer, never in the encrypted window", () => {
    setTrust({ master: KEY, verified: true, devices: 1 });
    setRows([{ kind: "in", id: "1", at, nick: "Bob", ed25519: KEY, body: "ciao" }]);
    renderPane();
    fireEvent.contextMenu(lines()[0]?.querySelector(".scrollback-sender") as HTMLElement);
    pressAndClick(screen.getByRole("button", { name: /^ctcp ▸$/i }));
    pressAndClick(screen.getByRole("button", { name: /^version$/i }));

    expect(sendCtcpQuery).toHaveBeenCalledWith(
      expect.objectContaining({ sourceChannel: "bob", targetNick: "Bob", verb: "VERSION" }),
    );
  });

  it("draws no line while our nick is unknown: an outgoing one would name nobody", () => {
    setRows([{ kind: "out", id: "2", at, body: "ciao bob", state: "sent", reason: null }]);
    render(() => (
      <EncryptedChatPane
        networkSlug="azzurra"
        nick="bob"
        ownNick={null}
        windowsOpener={null}
        railOpener={null}
        onDialogOpen={null}
      />
    ));
    expect(lines()).toEqual([]);
  });

  it("a message written with another key than the nick's pinned one is marked, the key in its label", () => {
    setTrust({ master: KEY, verified: true, devices: 1 });
    setRows([
      { kind: "in", id: "1", at, nick: "Bob", ed25519: KEY, body: "from the pinned key" },
      { kind: "in", id: "2", at, nick: "Bob", ed25519: OWN, body: "from another" },
    ]);
    renderPane();
    const [pinned, other] = lines();
    expect(pinned?.querySelector("[data-testid=e2e-row-other-key]")).toBeNull();
    expect(
      other?.querySelector("[data-testid=e2e-row-other-key]")?.getAttribute("aria-label"),
    ).toBe(`written with another key: ${OWN}`);
  });

  // issue 2512 — the scrollback pane any query has: the window opens on the
  // unread marker, and the chat is read once its last line has been seen with
  // the page visible. The chat counts what is unread, so the marker sits
  // after the line the count starts behind: a key event the badge counts (an
  // alarm) is no line, and one it does not count (a pin) is passed over.
  it("opens on the unread marker, and reads the chat once its last line is seen", async () => {
    setTrust({ master: KEY, verified: true, devices: 1 });
    setChat({ nick: "Bob", open: true, unread: 3 });
    setRows([
      { kind: "pinned", id: "p", at, nick: "Bob", ed25519: KEY },
      { kind: "in", id: "1", at, nick: "Bob", ed25519: KEY, body: "uno" },
      { kind: "in", id: "2", at, nick: "Bob", ed25519: KEY, body: "due" },
      { kind: "in", id: "3", at, nick: "Bob", ed25519: KEY, body: "tre" },
      { kind: "key_alarm", id: "a", at, nick: "Bob", presented: OWN },
    ]);
    renderPane();
    const marker = within("e2e-pane").querySelector("[data-testid=unread-marker]") as HTMLElement;
    expect(marker.textContent).toContain("2 unread messages");
    expect(body(marker.nextElementSibling as HTMLElement)).toBe("due");

    await waitFor(() => expect(readEncryptedChat).toHaveBeenCalledWith("azzurra", "bob"), {
      timeout: 2_000,
    });
  });

  // jsdom lays nothing out, so the window is read as a screen would show it:
  // lines 100px tall in a 150px viewport, scrolled to `scrollTop`, which the
  // pane cannot move (a phone's reader holds it).
  const screenAt = (top: { value: number }) => {
    const height = 100;
    const lineIndex = (el: HTMLElement) =>
      Array.from(
        el.closest("[data-testid=scrollback]")?.querySelectorAll(".scrollback-line") ?? [],
      ).indexOf(el);
    const isList = (el: Element) => el.matches("[data-testid=scrollback]");
    const define = (name: string, get: (el: HTMLElement) => number | undefined) => {
      const native = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
      const inherited = Object.getOwnPropertyDescriptor(Element.prototype, name);
      Object.defineProperty(HTMLElement.prototype, name, {
        configurable: true,
        get(this: HTMLElement) {
          return get(this) ?? (native ?? inherited)?.get?.call(this);
        },
        set(this: HTMLElement, value: number) {
          if (get(this) === undefined) (native ?? inherited)?.set?.call(this, value);
        },
      });
      return () => {
        if (native) Object.defineProperty(HTMLElement.prototype, name, native);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
      };
    };
    const restores = [
      define("offsetTop", (el) =>
        el.classList.contains("scrollback-line") ? lineIndex(el) * height : undefined,
      ),
      define("offsetHeight", (el) =>
        el.classList.contains("scrollback-line") ? height : undefined,
      ),
      define("clientHeight", (el) => (isList(el) ? 150 : undefined)),
      define("scrollHeight", (el) =>
        isList(el) ? el.querySelectorAll(".scrollback-line").length * height : undefined,
      ),
      define("scrollTop", (el) => (isList(el) ? top.value : undefined)),
    ];
    return () => {
      for (const restore of restores) restore();
    };
  };

  it("reads the chat once its last line has been seen, never while the reader is above it", async () => {
    const top = { value: 0 };
    const restore = screenAt(top);
    try {
      setChat({ nick: "Bob", open: true, unread: 3 });
      setRows([
        { kind: "in", id: "1", at, nick: "Bob", ed25519: KEY, body: "uno" },
        { kind: "in", id: "2", at, nick: "Bob", ed25519: KEY, body: "due" },
        { kind: "in", id: "3", at, nick: "Bob", ed25519: KEY, body: "tre" },
      ]);
      renderPane();
      const list = within("e2e-pane").querySelector("[data-testid=scrollback]") as HTMLElement;
      // Seen: the first line only.
      list.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      list.dispatchEvent(new Event("scroll"));
      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(readEncryptedChat).not.toHaveBeenCalled();

      // Down to the last line.
      top.value = 150;
      list.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      list.dispatchEvent(new Event("scroll"));
      await waitFor(() => expect(readEncryptedChat).toHaveBeenCalledWith("azzurra", "bob"), {
        timeout: 2_000,
      });
    } finally {
      restore();
    }
  });

  // The device holds every line of the chat and grappa's scrollback none:
  // nothing in the window asks grappa for more, which would ask it for a
  // window it has never heard of.
  it("asks grappa's scrollback for nothing: no older page at the top, no catch-up on the way back", async () => {
    setRows([
      { kind: "in", id: "1", at, nick: "Bob", ed25519: KEY, body: "uno" },
      { kind: "in", id: "2", at, nick: "Bob", ed25519: KEY, body: "due" },
    ]);
    renderPane();
    const list = within("e2e-pane").querySelector("[data-testid=scrollback]") as HTMLElement;
    list.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    list.scrollTop = 0;
    list.dispatchEvent(new Event("scroll"));
    setVisible(false);
    setVisible(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(loadMore).not.toHaveBeenCalled();
    expect(loadNewer).not.toHaveBeenCalled();
    expect(refreshScrollback).not.toHaveBeenCalled();
  });

  it("reads nothing while the page is hidden, and the chat once it shows", async () => {
    setVisible(false);
    setChat({ nick: "Bob", open: true, unread: 1 });
    setRows([{ kind: "in", id: "1", at, nick: "Bob", ed25519: KEY, body: "ciao" }]);
    renderPane();
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(readEncryptedChat).not.toHaveBeenCalled();

    setVisible(true);
    await waitFor(() => expect(readEncryptedChat).toHaveBeenCalledWith("azzurra", "bob"), {
      timeout: 2_000,
    });
  });

  // issue 2509 — rows not yet loaded are no "no line": a chat whose messages
  // the device has not read back yet must not be marked read unseen.
  it("reads nothing while the chat's rows are still loading", async () => {
    setChat({ nick: "Bob", open: true, unread: 2 });
    setRows(undefined);
    renderPane();
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(readEncryptedChat).not.toHaveBeenCalled();
  });

  // issue 2509 — a chat whose unread is a key event and no line (an alarm on
  // its card, the peer asking to compare emoji in its dialog) has no last line
  // to see: the window shown is what reads it. Left unread, it would be a
  // next-active stop no jump could clear.
  it.each([
    ["a key alarm", { kind: "key_alarm", id: "a", at, nick: "Bob", presented: OWN }],
    [
      "the peer asking to compare emoji",
      { kind: "sas_asked", id: "s", at, nick: "Bob", by: "peer" },
    ],
  ] satisfies [string, ChatRow][])(
    "reads a chat with no line whose unread is %s, once the page shows",
    async (_what, step) => {
      setTrust({ master: KEY, verified: false, devices: 1 });
      setVisible(false);
      setChat({ nick: "Bob", open: true, unread: 1 });
      setRows([{ kind: "pinned", id: "p", at, nick: "Bob", ed25519: KEY }, step]);
      renderPane();
      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(readEncryptedChat).not.toHaveBeenCalled();

      setVisible(true);
      await waitFor(() => expect(readEncryptedChat).toHaveBeenCalledWith("azzurra", "bob"), {
        timeout: 2_000,
      });
    },
  );
});

// The key exchange is done once the nick has a pinned key and no alarm is
// open, verified or not (vjt's ruling 1). Until then the chat body shows the
// one step still needed, and only that.
describe("EncryptedChatPane, the key-exchange step", () => {
  // issue 2507 (vjt): pinning a key by hand is for bots and for those who know
  // what they are doing, so the chat area holds no key to paste or copy: the
  // card says what to do, and the pin form and our own key are the rail's.
  it("no key yet: says what to do in words, and leaves pinning and our key to the rail", () => {
    renderPane();
    const step = within("e2e-step");
    expect(step.dataset.step).toBe("no-key");
    expect(step.textContent).toContain("no keys exchanged with Bob yet");
    expect(step.textContent).toContain("side panel");

    expect(within("e2e-pane").querySelector("input")).toBeNull();
    expect(step.querySelector("button")).toBeNull();
    expect(within("e2e-rail").contains(screen.getByTestId("e2e-pin-input"))).toBe(true);
    expect(within("e2e-rail").contains(screen.getByTestId("e2e-own-identity-copy"))).toBe(true);

    // Pinned, taken on first use or by hand: done, verified or not.
    setTrust({ master: KEY, verified: false, devices: 1 });
    expect(screen.queryByTestId("e2e-step")).toBeNull();
  });

  it("shows no step before the chat is loaded: a pinned peer never flashes as one with no key", () => {
    setRows(undefined);
    renderPane();
    expect(screen.queryByTestId("e2e-step")).toBeNull();

    setRows([]);
    expect(within("e2e-step").dataset.step).toBe("no-key");
  });

  it("an open alarm: the card holds no key to paste, the key they give you is pinned in the rail", () => {
    setTrust({ master: KEY, verified: true, devices: 1 });
    setRows([{ kind: "key_alarm", id: "a", at, nick: "Bob", presented: OWN }]);
    renderPane();

    expect(within("e2e-step").dataset.step).toBe("alarm");
    expect(within("e2e-step").textContent).toContain("side panel");
    expect(within("e2e-pane").querySelector("input")).toBeNull();
    expect(within("e2e-rail").contains(screen.getByTestId("e2e-pin-input"))).toBe(true);
  });

  it("an open alarm: the card and the rail both take the new key, unverified, until it is answered", () => {
    setTrust({ master: KEY, verified: true, devices: 1 });
    setRows([{ kind: "key_alarm", id: "a", at, nick: "Bob", presented: OWN }]);
    renderPane();
    expect(within("e2e-step").dataset.step).toBe("alarm");
    expect(within("e2e-step").textContent).not.toContain(OWN);
    expect(screen.getByTestId("e2e-rail-alarm-key").textContent).toBe(OWN);
    // Red as an alarm: a rule of its own, after `.e2e-key`'s colour it beats
    // at the same specificity (jsdom applies no stylesheet: read the sheet).
    expect(screen.getByTestId("e2e-rail-alarm-key").classList.contains("e2e-key-alarm")).toBe(true);
    expect(ruleBody(".e2e-key-alarm")).toMatch(/color:\s*var\(--error/);
    expect(themeCss.indexOf("\n.e2e-key-alarm {")).toBeGreaterThan(
      themeCss.indexOf("\n.e2e-key {"),
    );

    fireEvent.click(screen.getByTestId("e2e-alarm-accept"));
    expect(pinEncryptedKey).toHaveBeenCalledWith("azzurra", "bob", OWN, false);
    fireEvent.click(screen.getByTestId("e2e-rail-alarm-accept"));
    expect(pinEncryptedKey).toHaveBeenCalledTimes(2);

    setRows([
      { kind: "key_alarm", id: "a", at, nick: "Bob", presented: OWN },
      { kind: "accepted", id: "b", at, nick: "Bob", ed25519: OWN },
    ]);
    setTrust({ master: OWN, verified: false, devices: 1 });
    expect(screen.queryByTestId("e2e-step")).toBeNull();
    expect(screen.queryByTestId("e2e-alarm-accept")).toBeNull();
    expect(screen.queryByTestId("e2e-rail-alarm-accept")).toBeNull();
  });
});

// issue 2491: a message none of the peer's devices could read leaves a card,
// and asking for their keys again is the user's tap, never the window's.
describe("EncryptedChatPane, a message the peer could not read", () => {
  const unreadable: ChatRow = {
    kind: "out",
    id: "o",
    at,
    body: "still there?",
    state: "failed",
    reason: "unreadable",
  };
  const rekey = (phase: "asked" | "renewed" | "unanswered"): ChatRow => ({
    kind: "rekey",
    id: `r-${phase}`,
    at,
    nick: "Bob",
    phase,
  });

  beforeEach(() => {
    setTrust({ master: KEY, verified: true, devices: 1 });
  });

  it("says why on the row, and the card says what may have happened and asks for their keys only on a tap", () => {
    setRows([unreadable]);
    renderPane();

    expect(within("e2e-row-state").textContent).toBe(
      "not sent: none of the peer's devices can read it",
    );
    const step = within("e2e-step");
    expect(step.dataset.step).toBe("unreadable");
    expect(step.textContent).toContain("Bob could not read your last message");
    expect(step.textContent).toContain("someone else may be using the nick");
    expect(rekeyEncrypted).not.toHaveBeenCalled();
    // The compose line stays usable.
    expect(composeShut()).toBe(false);

    fireEvent.click(screen.getByTestId("e2e-rekey"));

    expect(rekeyEncrypted).toHaveBeenCalledWith("azzurra", "bob");
  });

  it("waits for the keys with no button, says when none came and offers to ask again, and goes once they did", () => {
    setRows([unreadable, rekey("asked")]);
    renderPane();
    expect(within("e2e-step").dataset.step).toBe("rekey-asked");
    expect(within("e2e-step").textContent).toBe("waiting for Bob's keys…");
    expect(screen.queryByTestId("e2e-rekey")).toBeNull();

    setRows([unreadable, rekey("asked"), rekey("unanswered")]);
    expect(within("e2e-step").dataset.step).toBe("rekey-unanswered");
    expect(within("e2e-step").textContent).toContain("Bob sent no keys");
    fireEvent.click(screen.getByTestId("e2e-rekey"));
    expect(rekeyEncrypted).toHaveBeenCalledWith("azzurra", "bob");

    setRows([unreadable, rekey("asked"), rekey("renewed")]);
    expect(screen.queryByTestId("e2e-step")).toBeNull();
  });

  it("gives way to the key alarm their new key raises", () => {
    setRows([
      unreadable,
      rekey("asked"),
      { kind: "key_alarm", id: "a", at, nick: "Bob", presented: OWN },
    ]);
    renderPane();
    expect(within("e2e-step").dataset.step).toBe("alarm");
  });
});

// The emoji comparison runs in the chat window, modal-like (vjt's ruling 2):
// it covers the body, and nothing is sent until it ends. Issue 2507 (vjt's
// ruling): it starts from one tap on the top bar's badge, `not verified` or
// `verified` (to check again), and from nowhere else.
describe("EncryptedChatPane, the emoji comparison", () => {
  // The button the badge sits in, if it is one.
  const door = () => screen.getByTestId("e2e-peer-trust").closest("button");

  // The handler sits on the button, so a keyboard's Enter or Space reaches
  // it: the test clicks the button, not the badge inside it.
  it("starts from a tap on the top bar's badge, not verified or verified by emoji", () => {
    setTrust({ master: KEY, verified: false, devices: 1 });
    renderPane();
    const bar = within("e2e-pane").querySelector("header") as HTMLElement;
    expect(bar.contains(door())).toBe(true);
    expect(door()?.getAttribute("aria-label")).toBe("not verified: compare emoji with Bob");
    fireEvent.click(door() as HTMLButtonElement);
    expect(verifyEncrypted).toHaveBeenCalledWith("azzurra", "bob", "start");

    setTrust({ master: KEY, verified: true, devices: 1 });
    setRows([
      { kind: "accepted", id: "a", at, nick: "Bob", ed25519: KEY },
      { kind: "verified", id: "v", at, nick: "Bob", ed25519: KEY },
      { kind: "sas_cancelled", id: "c", at, nick: "Bob", by: "you", reason: "user" },
    ]);
    expect(door()?.getAttribute("aria-label")).toBe("verified: compare emoji with Bob again");
    fireEvent.click(door() as HTMLButtonElement);
    expect(verifyEncrypted).toHaveBeenCalledTimes(2);
  });

  // A key pasted by hand was checked at its source, and a bot's always is: a
  // bot never answers a comparison, so offering one could only time out.
  it("a key verified by pasting it offers no comparison, nor one with no row left to say how", () => {
    setTrust({ master: KEY, verified: true, devices: 1 });
    setRows([{ kind: "pinned", id: "p", at, nick: "Bob", ed25519: KEY }]);
    renderPane();
    expect(door()).toBeNull();

    setRows([
      { kind: "verified", id: "v", at, nick: "Bob", ed25519: KEY },
      { kind: "pinned", id: "p", at, nick: "Bob", ed25519: KEY },
    ]);
    expect(door()).toBeNull();

    setRows([]);
    expect(door()).toBeNull();
  });

  it("the rail starts no comparison: none of its buttons does", () => {
    setTrust({ master: KEY, verified: false, devices: 1 });
    renderPane();
    const buttons = within("e2e-rail").querySelectorAll("button");
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) fireEvent.click(button);
    expect(verifyEncrypted).not.toHaveBeenCalled();
  });

  it("the badge is no door with no key pinned, an alarm open, a comparison running, or the identity elsewhere", () => {
    renderPane();
    expect(door()).toBeNull();

    setTrust({ master: KEY, verified: false, devices: 1 });
    expect(door()).not.toBeNull();
    setRows([{ kind: "key_alarm", id: "a", at, nick: "Bob", presented: OWN }]);
    expect(door()).toBeNull();

    setRows([]);
    setSas(view({ phase: "started" }));
    expect(door()).toBeNull();

    setSas(null);
    setElsewhere(true);
    expect(door()).toBeNull();
    fireEvent.click(screen.getByTestId("e2e-peer-trust"));
    expect(verifyEncrypted).not.toHaveBeenCalled();
  });

  const view = (over: Partial<SasView>): SasView => ({
    role: "a",
    phase: "started",
    confirmed: false,
    here: true,
    emoji: null,
    ...over,
  });

  it.each([
    [view({ phase: "started" }), "waiting", "A bot never answers: pin the key it prints instead"],
    [view({ phase: "keyed" }), "waiting", "waiting for Bob to accept"],
    [view({ role: "b", phase: "asked", here: false }), "asked", "Bob asks to compare emoji"],
    [view({ role: "b", phase: "accepted" }), "exchanging", "exchanging keys with Bob"],
    [view({ phase: "compare", here: false }), "elsewhere", "open in another tab"],
    [view({ phase: "compare", confirmed: true }), "confirmed", "waiting for Bob to confirm"],
  ])("a SAS (%o) reads %s, and can be cancelled", (shown, phase, text) => {
    setTrust({ master: KEY, verified: false, devices: 1 });
    setSas(shown);
    renderPane();
    const dialog = screen.getByTestId("e2e-sas");
    expect(dialog.dataset.phase).toBe(phase);
    expect(dialog.textContent).toContain(text);
    expect(door()).toBeNull();

    fireEvent.click(screen.getByTestId("e2e-sas-cancel"));
    expect(verifyEncrypted).toHaveBeenCalledWith("azzurra", "bob", "cancel");
  });

  it("covers the chat body as a dialog: the body is inert and nothing is sent until it ends", async () => {
    setTrust({ master: KEY, verified: false, devices: 1 });
    renderPane();
    const input = composer();
    type("not yet");
    const content = within("e2e-pane").querySelector(".e2e-body-content") as HTMLElement;
    expect(content.contains(input)).toBe(true);
    expect(content.inert).toBe(false);

    input.focus();
    setSas(view({ role: "b", phase: "asked", here: false }));
    const dialog = screen.getByRole("dialog");
    // Scoped to the pane: the top bar and the rail stay usable (the wait
    // says to pin a key in the rail), so it claims no modality over them,
    // and the focus the inert compose line loses moves into it.
    expect(dialog.hasAttribute("aria-modal")).toBe(false);
    expect(document.activeElement).toBe(dialog);
    expect(dialog.textContent).toContain("compare emoji with Bob");
    expect(within("e2e-pane").querySelector(".e2e-body")?.contains(dialog)).toBe(true);
    expect(content.inert).toBe(true);

    // Over: the draft is still there, and goes.
    setSas(null);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(content.inert).toBe(false);
    expect(input.value).toBe("not yet");
    enter();
    await waitFor(() => expect(sendEncrypted).toHaveBeenCalledWith("azzurra", "bob", "not yet"));
  });

  it("a request is accepted from the dialog", () => {
    setSas(view({ role: "b", phase: "asked", here: false }));
    renderPane();
    fireEvent.click(screen.getByTestId("e2e-sas-accept"));
    expect(verifyEncrypted).toHaveBeenCalledWith("azzurra", "bob", "accept");
  });

  it("shows the 7 emoji in order, each with its name, and sends the human's answer", () => {
    const emoji = [0, 29, 63, 1, 2, 3, 4];
    setSas(view({ phase: "compare", emoji }));
    renderPane();

    expect(screen.getByTestId("e2e-sas").dataset.phase).toBe("compare");
    const shown = screen.getAllByTestId("e2e-sas-emoji");
    expect(shown.map((e) => e.dataset.index)).toEqual(emoji.map(String));
    expect(shown.map((e) => e.textContent)).toEqual(
      emoji.map((i) => `${SAS_EMOJI[i]?.[0]}${SAS_EMOJI[i]?.[1]}`),
    );
    expect(shown[0]?.textContent).toBe("🐶Dog");

    fireEvent.click(screen.getByTestId("e2e-sas-match"));
    expect(verifyEncrypted).toHaveBeenCalledWith("azzurra", "bob", "match");
    fireEvent.click(screen.getByTestId("e2e-sas-mismatch"));
    expect(verifyEncrypted).toHaveBeenCalledWith("azzurra", "bob", "mismatch");
  });

  it("while the emoji are worked out, the comparison reads as exchanging keys", () => {
    setSas(view({ phase: "compare", emoji: null }));
    renderPane();
    expect(screen.getByTestId("e2e-sas").dataset.phase).toBe("exchanging");
    expect(screen.queryByTestId("e2e-sas-match")).toBeNull();
  });

  it.each([
    [{ kind: "verified", id: "v", at, nick: "Bob", ed25519: KEY }, "matched"],
    [
      { kind: "sas_cancelled", id: "c", at, nick: "Bob", by: "you", reason: "mismatch" },
      "stopped: the emoji did not match",
    ],
    [
      { kind: "sas_cancelled", id: "c", at, nick: "Bob", by: "peer", reason: "its own words" },
      'stopped by them: "its own words"',
    ],
  ] as [ChatRow, string][])("the rail says how the last comparison ended (%o)", (last, text) => {
    setTrust({ master: KEY, verified: false, devices: 1 });
    setRows([{ kind: "sas_asked", id: "a", at, nick: "Bob", by: "you" }, last]);
    renderPane();
    expect(screen.getByTestId("e2e-rail-comparison").textContent).toBe(text);
  });

  it.each([
    ["taken off an alarm", { kind: "accepted", id: "p", at, nick: "Bob", ed25519: OWN }],
    ["pinned by hand", { kind: "pinned", id: "p", at, nick: "Bob", ed25519: OWN }],
  ] as [string, ChatRow][])(
    "a key %s since says nothing of the last comparison: it was the old key's",
    (_how, chosen) => {
      setTrust({ master: OWN, verified: false, devices: 1 });
      setRows([
        { kind: "sas_asked", id: "a", at, nick: "Bob", by: "you" },
        { kind: "verified", id: "v", at, nick: "Bob", ed25519: KEY },
        { kind: "key_alarm", id: "k", at, nick: "Bob", presented: OWN },
        chosen,
      ]);
      renderPane();
      expect(screen.queryByTestId("e2e-rail-comparison")).toBeNull();
    },
  );
});

// issue 2485 — the bot's order challenges are answered without a row; what
// the user sees is the last identity check, compact in the top bar and in
// full in the rail.
describe("EncryptedChatPane, the last identity check", () => {
  const passed: IdentityCheck = {
    at: Date.now(),
    network: "AzzurraNet",
    channel: "#grappa",
    passed: true,
    reason: null,
  };

  it("shows none until a bot first challenges an order", () => {
    renderPane();
    expect(screen.queryByTestId("e2e-check-chip")).toBeNull();
    expect(screen.queryByTestId("e2e-identity-check")).toBeNull();
  });

  it("a passed check: a ✓ in the top bar, and where and when in the rail", () => {
    setChat({ nick: "Bob", open: true, unread: 0, check: passed });
    renderPane();
    const chip = screen.getByTestId("e2e-check-chip");
    expect(chip.dataset.passed).toBe("true");
    expect(chip.textContent).toContain("✓");
    expect(chip.getAttribute("title")).toContain("passed");
    expect(chip.getAttribute("title")).toContain("#grappa on AzzurraNet");

    const full = screen.getByTestId("e2e-identity-check");
    expect(full.dataset.passed).toBe("true");
    expect(full.textContent).toContain("passed");
    expect(full.textContent).toContain("#grappa on AzzurraNet");
  });

  // issue 2511 — on a phone the bar's buttons leave the title too little
  // width for the nick beside the badge: the title is two lines, the nick
  // alone on the first, the badge and the stamp under it.
  it("puts the stamp under the nick, beside the badge, in the title's second line", () => {
    setChat({ nick: "Bob", open: true, unread: 0, check: passed });
    renderPane();
    const lines = within("e2e-pane").querySelectorAll(".e2e-title > .e2e-title-line");
    expect(lines).toHaveLength(2);
    const [first, second] = Array.from(lines);
    expect(first?.querySelector(".e2e-heading")?.textContent).toBe("Bob");
    expect(first?.querySelector("[data-testid=e2e-peer-trust]")).toBeNull();
    expect(second?.querySelector("[data-testid=e2e-peer-trust]")).not.toBeNull();
    expect(second?.querySelector("[data-testid=e2e-check-chip]")).not.toBeNull();
  });

  it("a failed check is red and says why", () => {
    setChat({
      nick: "Bob",
      open: true,
      unread: 0,
      check: { ...passed, passed: false, reason: "other-network" },
    });
    renderPane();
    const chip = screen.getByTestId("e2e-check-chip");
    expect(chip.dataset.passed).toBe("false");
    expect(chip.textContent).toContain("✗");
    expect(chip.classList.contains("e2e-check-failed")).toBe(true);
    expect(chip.getAttribute("title")).toContain("failed");

    const full = screen.getByTestId("e2e-identity-check");
    expect(full.dataset.reason).toBe("other-network");
    expect(full.textContent).toContain("failed");
    expect(full.textContent).toContain("it names another network");
  });

  // A bot encrypts its challenge to every device of the account, and the send
  // log is the device's: a line typed on a sibling device reads `not-sent`
  // here, every time. Not answered HERE, then, and no red alarm over it.
  it("a line this device did not send reads as not answered here, not as a failure", () => {
    setChat({
      nick: "Bob",
      open: true,
      unread: 0,
      check: { ...passed, channel: "Bob", passed: false, reason: "not-sent" },
    });
    renderPane();
    const chip = screen.getByTestId("e2e-check-chip");
    expect(chip.dataset.passed).toBe("false");
    expect(chip.textContent).not.toContain("✗");
    expect(chip.classList.contains("e2e-check-failed")).toBe(false);
    expect(chip.classList.contains("e2e-check-unanswered")).toBe(true);
    expect(chip.getAttribute("title")).toContain("not answered here");

    const full = screen.getByTestId("e2e-identity-check");
    expect(full.dataset.reason).toBe("not-sent");
    expect(full.textContent).toContain("not answered here");
    expect(full.textContent).not.toContain("failed");
    expect(full.querySelector(".e2e-check-failed")).toBeNull();
    expect(full.textContent).toContain("a private message on AzzurraNet");
    expect(full.textContent).toContain("this cic sent no such line there in the last 15 s");
  });
});

describe("EncryptedChatPane, the rail", () => {
  // issue 2499 — the key sections mount inside the query context, whose
  // heading names the conversation: one of their own would read twice.
  it("carries no heading of its own: the query context it mounts in has one", () => {
    renderPane();
    expect(within("e2e-rail").querySelector(".rail-query-heading")).toBeNull();
  });

  it("shows the master the peer's nick is pinned to, and how many of its devices are trusted", () => {
    renderPane();
    expect(screen.getByTestId("e2e-peer-key").textContent).toBe("none yet");
    expect(screen.queryByTestId("e2e-peer-devices")).toBeNull();

    setTrust({ master: KEY, verified: false, devices: 2 });
    expect(screen.getByTestId("e2e-peer-key").textContent).toBe(KEY);
    expect(screen.getByTestId("e2e-peer-devices").textContent).toBe("2 devices");

    setTrust({ master: KEY, verified: false, devices: 1 });
    expect(screen.getByTestId("e2e-peer-devices").textContent).toBe("1 device");
    expect(within("e2e-rail").contains(screen.getByTestId("e2e-peer-key"))).toBe(true);
  });

  it("shows our own key, our master, and copies it", async () => {
    renderPane();
    expect(screen.getByTestId("e2e-own-identity").textContent).toBe(OWN);
    fireEvent.click(screen.getByTestId("e2e-own-identity-copy"));
    expect(copyText).toHaveBeenCalledWith(OWN);
  });

  it("offers add a device only on the master's browser, and a hint elsewhere", async () => {
    const view = renderPane();
    expect(await screen.findByTestId("e2e-add-device")).toBeTruthy();
    expect(holdsMasterHere).toHaveBeenCalledWith("azzurra");
    expect(screen.queryByTestId("e2e-add-device-hint")).toBeNull();
    view.unmount();

    holdsMasterHere.mockResolvedValue(false);
    renderPane();
    const hint = await screen.findByTestId("e2e-add-device-hint");
    expect(hint.textContent).toBe("Devices are added from the browser that started this identity.");
    expect(screen.queryByTestId("e2e-add-device")).toBeNull();
  });

  it("shows neither the button nor the hint until there is a key to ask about, then the answer", async () => {
    holdsMasterHere.mockResolvedValue(false);
    setOwn(undefined);
    renderPane();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(holdsMasterHere).not.toHaveBeenCalled();
    expect(screen.queryByTestId("e2e-add-device-hint")).toBeNull();
    expect(screen.queryByTestId("e2e-add-device")).toBeNull();

    setOwn(OWN);
    expect(await screen.findByTestId("e2e-add-device-hint")).toBeTruthy();
    expect(holdsMasterHere).toHaveBeenCalledWith("azzurra");
  });

  it("add a device opens the panel inline, and closing the panel removes it", async () => {
    renderPane();
    expect(screen.queryByTestId("add-device-panel")).toBeNull();
    fireEvent.click(await screen.findByTestId("e2e-add-device"));
    expect(screen.getByTestId("add-device-panel")).toBeTruthy();
    expect(screen.queryByTestId("e2e-add-device")).toBeNull();

    panel.onClose?.();
    expect(screen.queryByTestId("add-device-panel")).toBeNull();
    expect(panel.unmounted).toBe(1);
    expect(screen.getByTestId("e2e-add-device")).toBeTruthy();
  });

  it("says why a copy failed", async () => {
    copyText.mockRejectedValue(new Error("copy it by hand"));
    renderPane();
    fireEvent.click(screen.getByTestId("e2e-own-identity-copy"));
    expect(await screen.findByText("copy it by hand")).toBeTruthy();
  });

  it("pins the pasted key, trimmed, and clears the field", async () => {
    renderPane();
    const input = screen.getByTestId("e2e-pin-input") as HTMLInputElement;
    expect(within("e2e-rail").contains(input)).toBe(true);
    fireEvent.input(input, { target: { value: `  ${KEY}\n` } });
    fireEvent.click(screen.getByTestId("e2e-pin-submit"));

    await vi.waitFor(() => expect(input.value).toBe(""));
    expect(pinEncryptedKey).toHaveBeenCalledWith("azzurra", "bob", KEY, true);
    expect(screen.queryByTestId("e2e-pin-error")).toBeNull();
  });

  it("a pin that fails says what failed, logs the cause, and keeps what was pasted", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    pinEncryptedKey.mockRejectedValue(new Error("the network is gone"));
    renderPane();
    const input = screen.getByTestId("e2e-pin-input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: KEY } });
    fireEvent.click(screen.getByTestId("e2e-pin-submit"));

    expect((await screen.findByTestId("e2e-pin-error")).textContent).toContain(
      "the network is gone",
    );
    expect(input.value).toBe(KEY);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it.each([
    ["bad-key", "that is not an Ed25519 key"],
    ["own-key", "that is your own key"],
  ])("a refused pin (%s) says why and keeps what was pasted", async (result, message) => {
    pinEncryptedKey.mockResolvedValue(result);
    renderPane();
    const input = screen.getByTestId("e2e-pin-input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "garbage" } });
    fireEvent.click(screen.getByTestId("e2e-pin-submit"));

    expect((await screen.findByTestId("e2e-pin-error")).textContent).toContain(message);
    expect(input.value).toBe("garbage");
  });
});

describe("EncryptedChatPane, compose and the chat's tools", () => {
  // issue 2512 — the compose box every window has: a text area that wraps a
  // long line instead of scrolling it sideways, Enter sends, and what went is
  // in the window's history for the up arrow.
  it("sends what was typed through the encrypted door, and keeps it in the window's history", async () => {
    renderPane();
    const input = composer();
    expect(input.tagName).toBe("TEXTAREA");
    type("segreto");
    enter();

    await waitFor(() => expect(sendEncrypted).toHaveBeenCalledWith("azzurra", "bob", "segreto"));
    expect(input.value).toBe("");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("segreto");
  });

  it("sends nothing blank", async () => {
    renderPane();
    type("   ");
    enter();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendEncrypted).not.toHaveBeenCalled();
  });

  it("the magnifier opens a search over the messages, any case, counted; Esc closes it and shows all", () => {
    setTrust({ master: KEY, verified: true, devices: 1 });
    setRows([
      { kind: "in", id: "1", at, nick: "Bob", ed25519: KEY, body: "Ciao, the CODES are ready" },
      { kind: "out", id: "2", at, body: "which codes?", state: "sent", reason: null },
      { kind: "pinned", id: "3", at, nick: "Bob", ed25519: KEY },
      { kind: "in", id: "4", at, nick: "Bob", ed25519: KEY, body: "never mind" },
      { kind: "undecryptable", id: "5", at, nick: "Bob" },
    ]);
    renderPane();
    const shown = () => lines().map(line);
    expect(screen.queryByTestId("e2e-search-input")).toBeNull();

    const toggle = screen.getByTestId("e2e-search-toggle");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    const input = screen.getByTestId("e2e-search-input") as HTMLInputElement;
    expect(screen.queryByTestId("e2e-search-count")).toBeNull();

    fireEvent.input(input, { target: { value: " codes " } });
    expect(shown()).toEqual(["privmsg <Bob>", "privmsg <alice>"]);
    expect(screen.getByTestId("e2e-search-count").textContent).toBe("2 of 3 messages");

    fireEvent.input(input, { target: { value: "nothing like it" } });
    expect(lines()).toEqual([]);
    expect(screen.getByTestId("e2e-search-count").textContent).toBe("0 of 3 messages");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByTestId("e2e-search-input")).toBeNull();
    expect(shown()).toEqual([
      "privmsg <Bob>",
      "privmsg <alice>",
      "privmsg <Bob>",
      "server_event Bob",
    ]);

    // Opened again, it starts empty.
    fireEvent.click(toggle);
    expect((screen.getByTestId("e2e-search-input") as HTMLInputElement).value).toBe("");
  });

  it("the shredder asks first, and deletes the chat only on the dialog's yes", () => {
    renderPane();
    const shredder = screen.getByTestId("e2e-delete-chat");
    expect(shredder.getAttribute("aria-label")).toBe("delete the chat with Bob");

    fireEvent.click(shredder);
    const asked = confirmRequest();
    expect(asked?.title).toBe("Delete encrypted chat");
    expect(asked?.body).toContain("Delete the messages with Bob on this device?");
    expect(asked?.defaultButton).toBe("cancel");
    expect(deleteEncryptedChat).not.toHaveBeenCalled();

    acceptConfirm();
    expect(deleteEncryptedChat).toHaveBeenCalledWith("azzurra", "bob");
  });

  it("hosts the rail's door and the window list's at the ends of the bar", () => {
    render(() => (
      <EncryptedChatPane
        networkSlug="azzurra"
        nick="bob"
        ownNick="alice"
        windowsOpener={<button type="button" data-testid="windows-door" />}
        railOpener={<button type="button" data-testid="rail-door" />}
        onDialogOpen={null}
      />
    ));
    const bar = screen.getByTestId("e2e-pane").querySelector(".e2e-header-main") as HTMLElement;
    expect(bar.firstElementChild?.getAttribute("data-testid")).toBe("windows-door");
    expect(bar.lastElementChild?.getAttribute("data-testid")).toBe("rail-door");
  });

  // Mobile: the rail is a drawer over the pane, and the dialog opens behind
  // it when the peer asks while it is up.
  it("says each time the emoji comparison's dialog opens", () => {
    const opened = vi.fn();
    render(() => (
      <EncryptedChatPane
        networkSlug="azzurra"
        nick="bob"
        ownNick="alice"
        windowsOpener={null}
        railOpener={null}
        onDialogOpen={opened}
      />
    ));
    expect(opened).not.toHaveBeenCalled();

    setSas({ role: "b", phase: "asked", confirmed: false, here: false, emoji: null });
    expect(opened).toHaveBeenCalledTimes(1);
    // A step of the same comparison is no new dialog.
    setSas({ role: "b", phase: "accepted", confirmed: false, here: true, emoji: null });
    expect(opened).toHaveBeenCalledTimes(1);

    setSas(null);
    setSas({ role: "a", phase: "started", confirmed: false, here: true, emoji: null });
    expect(opened).toHaveBeenCalledTimes(2);
  });
});

// The account's identity for the network is held elsewhere (another device,
// or a wiped browser): never replaced silently. A card in the chat says so
// (vjt's ruling 4), offers pairing this browser first, then a new identity
// behind a confirmation that names what it destroys; nothing can be sent
// meanwhile, and the rail can act on nothing.
describe("EncryptedChatPane, an identity held elsewhere", () => {
  const LINK = `https://grappa.example/pair#pair=${"r".repeat(22)}.${"c".repeat(43)}`;

  it("says the identity is held elsewhere, offers both ways out, and keeps compose shut", () => {
    setTrust({ master: KEY, verified: false, devices: 1 });
    setElsewhere(true);
    renderPane();

    expect(screen.getByTestId("e2e-identity-elsewhere").textContent).toContain(
      "lives on another device, or was lost",
    );
    expect(within("e2e-step").dataset.step).toBe("elsewhere");
    expect(within("e2e-step").contains(screen.getByTestId("e2e-identity-replace"))).toBe(true);
    expect(screen.getByTestId("e2e-rail-elsewhere")).toBeTruthy();
    expect(screen.getByTestId("e2e-identity-pair-code")).toBeTruthy();
    expect(screen.getByTestId("e2e-identity-pair-submit")).toBeTruthy();
    expect(screen.getByTestId("e2e-identity-replace").textContent).toBe(
      "start a new identity here",
    );
    // Nothing that needs the identity: no key to copy or pin, no SAS.
    expect(screen.queryByTestId("e2e-own-identity")).toBeNull();
    expect(screen.queryByTestId("e2e-pin-input")).toBeNull();
    expect(screen.getByTestId("e2e-peer-trust").closest("button")).toBeNull();
    expect(composeShut()).toBe(true);
  });

  it("shuts the compose box on what was typed before, and opens it again once the network reads ready", () => {
    renderPane();
    type("typed");
    expect(composeShut()).toBe(false);
    setElsewhere(true);

    expect(composeShut()).toBe(true);
    expect(composer().value).toBe("typed");
    setElsewhere(false);
    expect(composeShut()).toBe(false);
  });

  it("offers no control that needs the identity: the alarm's key cannot be taken, the chat cannot be deleted", () => {
    setTrust({ master: KEY, verified: true, devices: 1 });
    setRows([{ kind: "key_alarm", id: "a", at, nick: "Bob", presented: OWN }]);
    setElsewhere(true);
    renderPane();
    const remove = screen.getByTestId("e2e-delete-chat") as HTMLButtonElement;

    expect(screen.queryByTestId("e2e-alarm-accept")).toBeNull();
    expect(screen.queryByTestId("e2e-rail-alarm-accept")).toBeNull();
    expect(remove.disabled).toBe(true);
    fireEvent.click(remove);
    expect(confirmRequest()).toBeNull();
    expect(deleteEncryptedChat).not.toHaveBeenCalled();

    // Once the network reads ready again, they come back.
    setElsewhere(false);
    expect(screen.getByTestId("e2e-alarm-accept")).toBeTruthy();
    expect(screen.getByTestId("e2e-rail-alarm-accept")).toBeTruthy();
    expect(remove.disabled).toBe(false);
  });

  it.each([
    ["the whole link", LINK],
    ["its fragment", `#pair=${"r".repeat(22)}.${"c".repeat(43)}`],
  ])("a pasted pairing link (%s) opens /pair with its code in the fragment", (_name, pasted) => {
    setElsewhere(true);
    renderPane();

    fireEvent.input(screen.getByTestId("e2e-identity-pair-code"), {
      target: { value: `  ${pasted}\n` },
    });
    fireEvent.click(screen.getByTestId("e2e-identity-pair-submit"));

    expect(loadDocument.mock.calls).toEqual([
      [`${window.location.origin}/pair#pair=${"r".repeat(22)}.${"c".repeat(43)}`],
    ]);
    expect(screen.queryByTestId("e2e-identity-pair-error")).toBeNull();
  });

  // Inside the app's router, as the pane really runs: an in-app route change
  // to /pair mounts PairScan before the URL (and its fragment) is pushed, so
  // PairScan finds no code. The link must load /pair as a new document, the
  // entry a camera scan takes, where PairScan reads the code and scrubs it.
  it("a pasted link loads /pair as a document, where PairScan reads the code and scrubs it", async () => {
    window.history.replaceState(null, "", "/");
    setElsewhere(true);
    const app = render(() => (
      <Router>
        <Route path="/" component={Pane} />
        <Route path="/pair" component={PairScan} />
      </Router>
    ));
    fireEvent.input(screen.getByTestId("e2e-identity-pair-code"), { target: { value: LINK } });
    fireEvent.click(screen.getByTestId("e2e-identity-pair-submit"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // No route change in the app: the pane stays, and no PairScan came up.
    expect(screen.queryByTestId("pair-invalid")).toBeNull();
    expect(screen.getByTestId("e2e-identity-elsewhere")).toBeTruthy();
    expect(window.location.pathname).toBe("/");
    const [target] = loadDocument.mock.calls.map(([url]) => url as string);
    expect(target).toBe(`${window.location.origin}/pair#pair=${"r".repeat(22)}.${"c".repeat(43)}`);

    // The browser loads that URL as a new document.
    app.unmount();
    window.history.replaceState(null, "", target);
    render(() => (
      <Router>
        <Route path="/pair" component={PairScan} />
      </Router>
    ));

    // Logged out here, so it asks for a login; what matters is that it read a code.
    expect(await screen.findByTestId("pair-login")).toBeTruthy();
    expect(screen.queryByTestId("pair-invalid")).toBeNull();
    expect(window.location.hash).toBe("");
    window.history.replaceState(null, "", "/");
  });

  it.each([
    ["not a link", "garbage"],
    ["a link with no code", "https://grappa.example/pair"],
    ["a code cut short", `#pair=${"r".repeat(22)}.${"c".repeat(42)}`],
  ])("a paste that is %s says so and goes nowhere", (_name, pasted) => {
    setElsewhere(true);
    renderPane();

    fireEvent.input(screen.getByTestId("e2e-identity-pair-code"), { target: { value: pasted } });
    fireEvent.click(screen.getByTestId("e2e-identity-pair-submit"));

    expect(screen.getByTestId("e2e-identity-pair-error").textContent).toContain(
      "that is not a pairing link",
    );
    expect(loadDocument).not.toHaveBeenCalled();
  });

  it("a new identity takes two taps, the second naming what it destroys", () => {
    setElsewhere(true);
    renderPane();
    const button = screen.getByTestId("e2e-identity-replace");

    fireEvent.click(button);

    expect(replaceEncryptedIdentity).not.toHaveBeenCalled();
    const confirm = button.textContent ?? "";
    expect(confirm).toContain("every other device of this account loses this identity");
    expect(confirm).toContain("every contact sees a key alarm and must verify it again");
    expect(confirm).toContain("nothing encrypted to the old identity can be read here");
  });

  it("confirmed, starts the new identity, and once the network reads ready, compose opens", async () => {
    replaceEncryptedIdentity.mockImplementation(async () => {
      setElsewhere(false);
    });
    setElsewhere(true);
    renderPane();
    const button = screen.getByTestId("e2e-identity-replace");

    fireEvent.click(button);
    fireEvent.click(button);

    expect(replaceEncryptedIdentity).toHaveBeenCalledWith("azzurra");
    await vi.waitFor(() => expect(composeShut()).toBe(false));
    expect(screen.queryByTestId("e2e-identity-elsewhere")).toBeNull();
    expect(screen.getByTestId("e2e-own-identity").textContent).toBe(OWN);
  });

  it("a new identity cannot be asked for twice while one is being made", async () => {
    let done: () => void = () => undefined;
    replaceEncryptedIdentity.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          done = resolve;
        }),
    );
    setElsewhere(true);
    renderPane();
    const button = screen.getByTestId("e2e-identity-replace") as HTMLButtonElement;

    fireEvent.click(button);
    fireEvent.click(button);
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    fireEvent.click(button);

    expect(replaceEncryptedIdentity).toHaveBeenCalledTimes(1);
    done();
    await vi.waitFor(() => expect(button.disabled).toBe(false));
  });

  it("a new identity grappa refused says why, logs the cause, and is still offered", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const refused = new ApiError(503, "unavailable");
    replaceEncryptedIdentity.mockRejectedValue(refused);
    setElsewhere(true);
    renderPane();
    const button = screen.getByTestId("e2e-identity-replace");

    fireEvent.click(button);
    fireEvent.click(button);

    expect((await screen.findByTestId("e2e-identity-replace-error")).textContent).toBe(
      friendlyApiError(refused),
    );
    expect(warn).toHaveBeenCalledWith("[e2e] could not start a new identity on azzurra", refused);
    expect(button.textContent).toBe("start a new identity here");
    expect(composeShut()).toBe(true);
    warn.mockRestore();
  });

  it("a new identity that failed on this device says what failed, not that the server is away", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const broken = new Error("the database is closing");
    replaceEncryptedIdentity.mockRejectedValue(broken);
    setElsewhere(true);
    renderPane();
    const button = screen.getByTestId("e2e-identity-replace");

    fireEvent.click(button);
    fireEvent.click(button);

    expect((await screen.findByTestId("e2e-identity-replace-error")).textContent).toBe(
      "could not start a new identity: the database is closing",
    );
    expect(warn).toHaveBeenCalledWith("[e2e] could not start a new identity on azzurra", broken);
    warn.mockRestore();
  });
});
