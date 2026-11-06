import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import { channelKey } from "../lib/channelKey";
import { setDraft } from "../lib/compose";
import { acceptConfirm, confirmRequest, dismissConfirm } from "../lib/confirmDialog";
import type { Chat, ChatRow, IdentityCheck } from "../lib/e2e/chatStore";
import type { PeerTrust } from "../lib/e2e/client";
import type { ElsewhereReason } from "../lib/e2e/identity";
import type { SasView } from "../lib/e2e/sas";
import { SAS_EMOJI } from "../lib/e2e/sasEmoji";
import { friendlyApiError } from "../lib/friendlyApiError";
import {
  overlayCount,
  overlayEscapeDepth,
  runTopmostOverlayEscape,
} from "../lib/overlayScrollLock";
import { wireBody } from "../lib/sendPipeline";
import { pressAndClick } from "./helpers/pointerEvents";
import { ruleBody, themeCss } from "./helpers/themeCss";

// issue 2430 — the encrypted query window: the pane, and since issue 2485 its
// technical half in the right rail (EncryptedRail), rendered side by side as
// Shell mounts them. The chat glue (lib/encryptedChats) is the boundary: its
// reads are signals here and its verbs are spies, so these tests pin what the
// window shows where, and which verb each control reaches. `trustOf`,
// `openAlarm` and `unreadableStep` stay the real ones: the badge and the step are their answers,
// not copies of them.
// A key is a master.

const KEY = "J2bCqN5ukKUq1qDNgzWbn9GZ7xjzM2bA0f9yqkvq0Ss";
const OWN = "7hPz0kdkCq0cH1L2oW9i3l0gq3uM8V8vxa5w8Kq2yYk";

const [chat, setChat] = createSignal<Chat | undefined>(undefined);
const [rows, setRows] = createSignal<ChatRow[] | undefined>(undefined);
const [trust, setTrust] = createSignal<PeerTrust | null>(null);
const [own, setOwn] = createSignal<string | undefined>(undefined);
const [visible, setVisible] = createSignal(true);
const [sas, setSas] = createSignal<SasView | null>(null);
// issue 2547 — why the network's identity is elsewhere, or null while it is
// not: `identityElsewhere` is derived from it, as encryptedChats derives it.
const [elsewhere, setElsewhere] = createSignal<ElsewhereReason | null>(null);
// issue 2513 — the one chat (`slug/nick`) the sidebar's toggle shows as its
// ciphertext, or none.
const [wireView, setWireView] = createSignal<string | null>(null);

const loadEncryptedChat = vi.hoisted(() => vi.fn());
const readEncryptedChat = vi.hoisted(() => vi.fn());
const sendEncrypted = vi.hoisted(() => vi.fn());
const pinEncryptedKey = vi.hoisted(() => vi.fn());
const verifyEncrypted = vi.hoisted(() => vi.fn());
const deleteEncryptedChat = vi.hoisted(() => vi.fn());
const replaceEncryptedIdentity = vi.hoisted(() => vi.fn());
const identityDevices = vi.hoisted(() => vi.fn());
const rekeyEncrypted = vi.hoisted(() => vi.fn());
const copyText = vi.hoisted(() => vi.fn());
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
  identityElsewhere: () => elsewhere() !== null,
  elsewhereReason: () => elsewhere(),
  identityDevices,
  // issue 2513 — the sidebar's toggle (its own tests drive it): the pane reads
  // it for its own chat, never another's.
  encryptedWireView: (slug: string, nick: string) => wireView() === `${slug}/${nick}`,
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

const {
  default: EncryptedChatPane,
  ELSEWHERE_WHY,
  heldDevicesLine,
  NO_CIPHERTEXT,
  UNSENT,
} = await import("../EncryptedChatPane");
const { default: EncryptedRail } = await import("../EncryptedRail");
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
  identityDevices.mockResolvedValue({ listed: 1, lastActive: null });
  holdsMasterHere.mockResolvedValue(true);
  panel.mounted = 0;
  panel.unmounted = 0;
  setChat({ nick: "Bob", open: true, unread: 0 });
  setRows([]);
  setTrust(null);
  setOwn(OWN);
  setVisible(true);
  setSas(null);
  setElsewhere(null);
  setWireView(null);
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

  // issue 2513 — the ciphertext view: each message reads as the payloads it
  // went over IRC as, on the line it holds in the plaintext view, so the
  // unread marker and the delivery state stay on it.
  it("in the ciphertext view each message reads as the payloads it travelled as, on its own line; the plaintext comes back with the toggle (issue 2513)", () => {
    const read = {
      verb: "msg",
      msgid: "cXV1eHF1dXh",
      payload: '{"ck":"y","bodies":{"d":"e"}}',
    } as const;
    const sent = {
      verb: "pkmsg",
      msgid: "Zm9vYmFyYmF",
      payload: '{"id":{},"bodies":{"a":"b"}}',
    } as const;
    const again = {
      verb: "msg",
      msgid: "YmF6cXV4cXV",
      payload: '{"ck":"x","bodies":{"a":"c"}}',
    } as const;
    const lost = {
      verb: "pkmsg",
      msgid: "bG9zdGxvc3R",
      payload: '{"id":{},"bodies":{"f":"g"}}',
    } as const;
    setTrust({ master: KEY, verified: true, devices: 1 });
    setRows([
      { kind: "in", id: "1", at, nick: "Bob", ed25519: KEY, body: "ciao", wire: [read] },
      { kind: "out", id: "2", at, body: "twice", state: "sent", reason: null, wire: [sent, again] },
      { kind: "out", id: "3", at, body: "later", state: "queued", reason: null },
      { kind: "undecryptable", id: "4", at, nick: "Bob", wire: [lost] },
      // Kept before this device kept ciphertext: there is none to show.
      { kind: "in", id: "5", at, nick: "Bob", ed25519: KEY, body: "old" },
      { kind: "pinned", id: "6", at, nick: "Bob", ed25519: KEY },
      { kind: "out", id: "7", at, body: "huge", state: "failed", reason: "too-large" },
      // A copy from one of our other devices: it crossed, elsewhere.
      { kind: "out", id: "8", at, body: "copied", state: "sent", reason: null },
    ]);
    renderPane();
    const plaintext = lines().map((row) => row.textContent);

    // Another chat's toggle is not this one's.
    setWireView("azzurra/carol");
    expect(lines().map((row) => row.textContent)).toEqual(plaintext);
    setWireView("libera/bob");
    expect(lines().map((row) => row.textContent)).toEqual(plaintext);

    setWireView("azzurra/bob");
    const shown = lines();
    expect(shown.map(line)).toEqual([
      "privmsg <Bob>",
      "privmsg <alice>",
      "privmsg <alice>",
      "privmsg <Bob>",
      "privmsg <Bob>",
      "privmsg <alice>",
      "privmsg <alice>",
    ]);
    expect(shown.map(body)).toEqual([
      `E2E MSG cXV1eHF1dXh {"ck":"y","bodies":{"d":"e"}}`,
      `E2E PKMSG Zm9vYmFyYmF {"id":{},"bodies":{"a":"b"}}\nE2E MSG YmF6cXV4cXV {"ck":"x","bodies":{"a":"c"}}`,
      // Not sent: no ciphertext anywhere, and the line's state says why.
      UNSENT,
      `E2E PKMSG bG9zdGxvc3R {"id":{},"bodies":{"f":"g"}}`,
      NO_CIPHERTEXT,
      UNSENT,
      NO_CIPHERTEXT,
    ]);
    // The delivery state still says where a message is, and no plaintext shows.
    expect(shown[2]?.textContent).toContain("waiting for keys");
    expect(shown[5]?.textContent).toContain("not sent: it is too large");
    const list = within("e2e-pane").querySelector("[data-testid=scrollback]") as HTMLElement;
    for (const text of ["ciao", "twice", "later", "old", "huge", "copied"]) {
      expect(list.textContent).not.toContain(text);
    }

    setWireView(null);
    expect(lines().map((row) => row.textContent)).toEqual(plaintext);
  });

  // issue 2513 — the search filters the lines as shown: in the ciphertext view
  // that is the ciphertext (a msgid finds its message), never the plaintext
  // behind it, and a message that could not be read is one of them there.
  it("in the ciphertext view the search looks in the ciphertext, not the plaintext (issue 2513)", () => {
    const wire = (msgid: string) => [{ verb: "msg" as const, msgid, payload: '{"ck":"z"}' }];
    setTrust({ master: KEY, verified: true, devices: 1 });
    setRows([
      {
        kind: "in",
        id: "1",
        at,
        nick: "Bob",
        ed25519: KEY,
        body: "the codes",
        wire: wire("Q29kZXNjb2R"),
      },
      {
        kind: "out",
        id: "2",
        at,
        body: "which codes?",
        state: "sent",
        reason: null,
        wire: wire("V2hpY2hjb2R"),
      },
      { kind: "undecryptable", id: "3", at, nick: "Bob", wire: wire("TG9zdGxvc3R") },
    ]);
    setWireView("azzurra/bob");
    renderPane();
    fireEvent.click(screen.getByTestId("e2e-search-toggle"));
    const input = screen.getByTestId("e2e-search-input") as HTMLInputElement;

    fireEvent.input(input, { target: { value: "codes" } });
    expect(lines()).toEqual([]);
    expect(screen.getByTestId("e2e-search-count").textContent).toBe("0 of 3 messages");

    fireEvent.input(input, { target: { value: "v2hpy2hjb2r" } });
    expect(lines().map(body)).toEqual([`E2E MSG V2hpY2hjb2R {"ck":"z"}`]);

    fireEvent.input(input, { target: { value: "TG9zdGxvc3R" } });
    expect(lines().map(line)).toEqual(["privmsg <Bob>"]);
    expect(screen.getByTestId("e2e-search-count").textContent).toBe("1 of 3 messages");
  });

  // issue 2536 — `/me` in an encrypted query rides inside the message as a
  // CTCP ACTION, and either side's line is the scrollback's action line, as
  // in any query, still marked encrypted and still carrying its state.
  it("a message carrying an ACTION is the scrollback's action line, the peer's and ours", () => {
    setTrust({ master: KEY, verified: true, devices: 1 });
    setRows([
      { kind: "in", id: "1", at, nick: "Bob", ed25519: KEY, body: "\x01ACTION waves\x01" },
      { kind: "out", id: "2", at, body: "\x01ACTION waves back\x01", state: "sent", reason: null },
      { kind: "out", id: "3", at, body: "ACTION is a word", state: "sent", reason: null },
    ]);
    renderPane();
    const shown = lines();
    expect(shown.map((row) => row.dataset.kind)).toEqual(["action", "action", "privmsg"]);
    expect(body(shown[0])).toBe("* Bob waves");
    expect(body(shown[1])).toBe("* alice waves back");
    expect(body(shown[2])).toBe("ACTION is a word");
    expect(shown.every((row) => row.querySelector(".encrypted-marker") !== null)).toBe(true);
    expect(shown[1]?.querySelector("[data-testid=e2e-row-state]")?.getAttribute("data-state")).toBe(
      "sent",
    );
  });

  // issues 2513 + 2536 — the ciphertext view shows what crossed IRC, and an
  // ACTION crossed as payloads like any message: its line is the payloads,
  // never the action line, and the `/me` behind it does not show.
  it("in the ciphertext view a message carrying an ACTION is the payloads it crossed as, not an action line", () => {
    const sent = {
      verb: "msg",
      msgid: "QWN0aW9uYWN",
      payload: '{"ck":"w","bodies":{"a":"b"}}',
    } as const;
    setTrust({ master: KEY, verified: true, devices: 1 });
    setRows([
      {
        kind: "out",
        id: "1",
        at,
        body: "\x01ACTION waves\x01",
        state: "sent",
        reason: null,
        wire: [sent],
      },
    ]);
    setWireView("azzurra/bob");
    renderPane();
    const shown = lines();

    expect(shown.map(line)).toEqual(["privmsg <alice>"]);
    expect(shown.map(body)).toEqual([`E2E MSG QWN0aW9uYWN {"ck":"w","bodies":{"a":"b"}}`]);
    expect(shown[0]?.textContent).not.toContain("waves");
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

  // A verb from a nick's menu answers in the plain query with the peer, as it
  // would from any query window (issue 2498), never here: the window a
  // command typed in it runs in too (issue 2536).
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
  // issue 2507 (vjt): the chat area holds no key to copy: the card says what
  // to do, and our own key is the rail's. Issue 2544: a bot's key is taken as
  // any other and verified by comparing it, so nothing anywhere pastes one.
  it("no key yet: says what to do in words, leaves our key to the rail, and nothing pastes one", () => {
    renderPane();
    const step = within("e2e-step");
    expect(step.dataset.step).toBe("no-key");
    expect(step.textContent).toContain("no keys exchanged with Bob yet");
    expect(step.textContent).toContain("side panel");
    expect(step.textContent).toContain("verify it");

    expect(within("e2e-pane").querySelector("input")).toBeNull();
    expect(within("e2e-rail").querySelector("input")).toBeNull();
    expect(step.querySelector("button")).toBeNull();
    expect(within("e2e-rail").contains(screen.getByTestId("e2e-own-identity-copy"))).toBe(true);
    // Nothing to verify yet.
    expect(screen.queryByTestId("e2e-peer-verify")).toBeNull();

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

  // issue 2544 (vjt): either the new key is theirs, or someone is in the
  // middle and the chat must be closed; pasting another key fixes neither.
  it("an open alarm: the card says to take the new key or close the chat, and nothing pastes a key", () => {
    setTrust({ master: KEY, verified: false, devices: 1 });
    setRows([{ kind: "key_alarm", id: "a", at, nick: "Bob", presented: OWN }]);
    renderPane();

    expect(within("e2e-step").dataset.step).toBe("alarm");
    expect(within("e2e-step").textContent).toContain("take the new key and verify it");
    expect(within("e2e-step").textContent).toContain("delete this chat");
    expect(within("e2e-pane").querySelector("input")).toBeNull();
    expect(within("e2e-rail").querySelector("input")).toBeNull();
    // The alarm is answered first: the pinned key offers no verify meanwhile.
    expect(screen.queryByTestId("e2e-peer-verify")).toBeNull();
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

  const keyDialog = () => screen.queryByTestId("e2e-key-dialog");
  const content = () => within("e2e-pane").querySelector(".e2e-body-content") as HTMLElement;

  // issue 2544 (vjt's ruling): the tap shows the key, the full 256 bits, to
  // compare out of band; the emoji are a 42-bit summary, offered only as the
  // synchronous comparison, and only for a key not verified yet. The handler
  // sits on the button, so a keyboard's Enter or Space reaches it: the test
  // clicks the button, not the badge inside it.
  it("not verified: a tap on the badge shows the whole key, verify, and the emoji comparison second", async () => {
    setTrust({ master: KEY, verified: false, devices: 1 });
    renderPane();
    const bar = within("e2e-pane").querySelector("header") as HTMLElement;
    expect(bar.contains(door())).toBe(true);
    expect(door()?.getAttribute("aria-label")).toBe("not verified: show Bob's key");
    expect(keyDialog()).toBeNull();

    fireEvent.click(door() as HTMLButtonElement);
    const dialog = keyDialog() as HTMLElement;
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.textContent).toContain("Bob's key");
    expect(screen.getByTestId("e2e-key-dialog-key").textContent).toBe(KEY);
    expect(KEY).toHaveLength(43);
    expect(document.activeElement).toBe(dialog);
    expect(content().inert).toBe(true);
    expect(within("e2e-pane").querySelector(".e2e-body")?.contains(dialog)).toBe(true);
    // The tap starts nothing by itself.
    expect(verifyEncrypted).not.toHaveBeenCalled();
    const actions = Array.from(dialog.querySelectorAll("button")).map((b) => b.dataset.testid);
    expect(actions).toEqual(["e2e-key-verify", "e2e-key-compare", "e2e-key-close"]);

    // Verify: the shown key pinned again, verified, and the dialog goes.
    fireEvent.click(screen.getByTestId("e2e-key-verify"));
    expect(pinEncryptedKey).toHaveBeenCalledWith("azzurra", "bob", KEY, true);
    await waitFor(() => expect(keyDialog()).toBeNull());
    expect(content().inert).toBe(false);

    // The emoji comparison, the second action: the dialog gives way to it.
    fireEvent.click(door() as HTMLButtonElement);
    fireEvent.click(screen.getByTestId("e2e-key-compare"));
    expect(verifyEncrypted).toHaveBeenCalledWith("azzurra", "bob", "start");
    expect(keyDialog()).toBeNull();
  });

  it("verified, however it was: a tap on the badge shows the whole key and nothing to do with it", () => {
    setTrust({ master: KEY, verified: true, devices: 1 });
    setRows([
      { kind: "accepted", id: "a", at, nick: "Bob", ed25519: KEY },
      { kind: "verified", id: "v", at, nick: "Bob", ed25519: KEY },
    ]);
    renderPane();
    expect(door()?.getAttribute("aria-label")).toBe("verified: show Bob's key");
    fireEvent.click(door() as HTMLButtonElement);
    expect(screen.getByTestId("e2e-key-dialog-key").textContent).toBe(KEY);
    expect(screen.queryByTestId("e2e-key-verify")).toBeNull();
    expect(screen.queryByTestId("e2e-key-compare")).toBeNull();
    expect(screen.queryByTestId("e2e-sas-emoji")).toBeNull();

    // Close, and the focus goes back to the badge.
    fireEvent.click(screen.getByTestId("e2e-key-close"));
    expect(keyDialog()).toBeNull();
    expect(document.activeElement).toBe(door());

    // Pinned by hand, or no row left to say how: the same.
    for (const rowsNow of [[{ kind: "pinned", id: "p", at, nick: "Bob", ed25519: KEY }], []]) {
      setRows(rowsNow as ChatRow[]);
      fireEvent.click(door() as HTMLButtonElement);
      expect(screen.getByTestId("e2e-key-dialog-key").textContent).toBe(KEY);
      expect(screen.queryByTestId("e2e-key-compare")).toBeNull();
      fireEvent.click(screen.getByTestId("e2e-key-close"));
    }
    expect(verifyEncrypted).not.toHaveBeenCalled();
  });

  // It covers the scrollback: a covering overlay, whose Esc comes through
  // the shared stack the one global keydown listener runs.
  it("Esc closes the key, and a comparison the peer asks for meanwhile takes its place", async () => {
    setTrust({ master: KEY, verified: false, devices: 1 });
    renderPane();
    fireEvent.click(door() as HTMLButtonElement);
    await waitFor(() => expect(overlayEscapeDepth()).toBe(1));
    expect(overlayCount()).toBe(1);
    expect(runTopmostOverlayEscape()).toBe(true);
    expect(keyDialog()).toBeNull();
    expect(document.activeElement).toBe(door());
    expect(overlayEscapeDepth()).toBe(0);
    expect(overlayCount()).toBe(0);

    fireEvent.click(door() as HTMLButtonElement);
    setSas(view({ role: "b", phase: "asked", here: false }));
    expect(keyDialog()).toBeNull();
    expect(screen.getByTestId("e2e-sas")).toBeTruthy();
    // Over, the key does not come back by itself.
    setSas(null);
    expect(keyDialog()).toBeNull();
  });

  // The pin is a round trip: one that lands once the dialog it came from is
  // gone closes nothing, not even the dialog opened since.
  it("a verify that lands after its dialog closed leaves the one opened since alone", async () => {
    let land: (outcome: string) => void = () => undefined;
    pinEncryptedKey.mockReturnValue(new Promise((resolve) => (land = resolve)));
    setTrust({ master: KEY, verified: false, devices: 1 });
    renderPane();
    fireEvent.click(door() as HTMLButtonElement);
    fireEvent.click(screen.getByTestId("e2e-key-verify"));
    fireEvent.click(screen.getByTestId("e2e-key-close"));
    fireEvent.click(door() as HTMLButtonElement);
    const reopened = keyDialog();
    expect(reopened).not.toBeNull();

    land("pinned");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(keyDialog()).toBe(reopened);
    expect(document.activeElement).toBe(reopened);
  });

  // Measured on both phone projects (CI): the refresh the pin sets off lands
  // before the pin answers, so the button goes with the unverified state
  // while its dialog is still open.
  it("a verify whose key reads verified before the pin answers still closes its dialog", async () => {
    let land: (outcome: string) => void = () => undefined;
    pinEncryptedKey.mockReturnValue(new Promise((resolve) => (land = resolve)));
    setTrust({ master: KEY, verified: false, devices: 1 });
    renderPane();
    fireEvent.click(door() as HTMLButtonElement);
    fireEvent.click(screen.getByTestId("e2e-key-verify"));
    setTrust({ master: KEY, verified: true, devices: 1 });
    expect(screen.queryByTestId("e2e-key-verify")).toBeNull();

    land("pinned");
    await waitFor(() => expect(keyDialog()).toBeNull());
    expect(document.activeElement).toBe(door());
  });

  it("a verify that fails keeps the key on screen and says what failed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    pinEncryptedKey.mockRejectedValue(new Error("the network is gone"));
    setTrust({ master: KEY, verified: false, devices: 1 });
    renderPane();
    fireEvent.click(door() as HTMLButtonElement);
    fireEvent.click(screen.getByTestId("e2e-key-verify"));
    expect((await screen.findByTestId("e2e-key-verify-error")).textContent).toContain(
      "the network is gone",
    );
    expect(keyDialog()).not.toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
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
    setElsewhere("no-keys");
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
    [view({ phase: "started" }), "waiting", "A bot never answers: compare the key it prints"],
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
    // says to verify a bot's key by hand), so it claims no modality over
    // them, and the focus the inert compose line loses moves into it.
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

  // issue 2544 (vjt's ruling): the key shown is verified with a button, for
  // when the user compared it with the peer out of band; nothing pastes one.
  it("verifies the key shown with the button beside it, and the button goes once it is verified", async () => {
    setTrust({ master: KEY, verified: false, devices: 1 });
    setRows([{ kind: "accepted", id: "a", at, nick: "Bob", ed25519: KEY }]);
    renderPane();
    const verify = screen.getByTestId("e2e-peer-verify");
    expect(within("e2e-rail-peer").contains(verify)).toBe(true);
    expect(verify.textContent).toBe("verify");
    fireEvent.click(verify);
    expect(pinEncryptedKey).toHaveBeenCalledWith("azzurra", "bob", KEY, true);
    await waitFor(() => expect((verify as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByTestId("e2e-peer-verify-error")).toBeNull();

    setTrust({ master: KEY, verified: true, devices: 1 });
    expect(screen.queryByTestId("e2e-peer-verify")).toBeNull();
  });

  it("offers no verify with no key yet, while a comparison runs, or with the identity elsewhere", () => {
    renderPane();
    expect(screen.queryByTestId("e2e-peer-verify")).toBeNull();
    setTrust({ master: KEY, verified: false, devices: 1 });
    expect(screen.getByTestId("e2e-peer-verify")).toBeTruthy();
    // The badge's door is shut while one runs; the rail's is too.
    setSas({ role: "a", phase: "started", confirmed: false, here: true, emoji: null });
    expect(screen.queryByTestId("e2e-peer-verify")).toBeNull();
    setSas(null);
    expect(screen.getByTestId("e2e-peer-verify")).toBeTruthy();
    setElsewhere("no-keys");
    expect(screen.queryByTestId("e2e-peer-verify")).toBeNull();
  });

  it("holds no form to paste a key", () => {
    setTrust({ master: KEY, verified: false, devices: 1 });
    renderPane();
    expect(within("e2e-rail").querySelector("input, form")).toBeNull();
  });

  it("a verify that fails says what failed and logs the cause", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    pinEncryptedKey.mockRejectedValue(new Error("the network is gone"));
    setTrust({ master: KEY, verified: false, devices: 1 });
    renderPane();
    fireEvent.click(screen.getByTestId("e2e-peer-verify"));

    expect((await screen.findByTestId("e2e-peer-verify-error")).textContent).toBe(
      "could not verify the key: the network is gone",
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it.each([
    ["bad-key", "that is not an Ed25519 key"],
    ["own-key", "that is your own key"],
  ])("a refused verify (%s) says why", async (result, message) => {
    pinEncryptedKey.mockResolvedValue(result);
    setTrust({ master: KEY, verified: false, devices: 1 });
    renderPane();
    fireEvent.click(screen.getByTestId("e2e-peer-verify"));
    expect((await screen.findByTestId("e2e-peer-verify-error")).textContent).toContain(message);
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

  // issues 2513 + 2536 — the ciphertext view changes what the lines show, not
  // what the compose box does: `/me` still goes to the peer encrypted as an
  // ACTION, and any other command still runs instead of reaching the peer.
  it("in the ciphertext view the compose box still sends /me encrypted and keeps a command from the peer", async () => {
    setWireView("azzurra/bob");
    renderPane();
    type("/me waves");
    enter();
    await waitFor(() =>
      expect(sendEncrypted).toHaveBeenCalledWith("azzurra", "bob", wireBody("waves", true)),
    );

    sendEncrypted.mockClear();
    type("/whois bob");
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

  // issue 2536 — the search reads what a line says: an ACTION's envelope is
  // framing, not text.
  it("the search finds an ACTION by its words, never by its envelope", () => {
    setTrust({ master: KEY, verified: true, devices: 1 });
    setRows([
      { kind: "in", id: "1", at, nick: "Bob", ed25519: KEY, body: "\x01ACTION waves\x01" },
      { kind: "in", id: "2", at, nick: "Bob", ed25519: KEY, body: "ciao" },
    ]);
    renderPane();
    fireEvent.click(screen.getByTestId("e2e-search-toggle"));
    const input = screen.getByTestId("e2e-search-input") as HTMLInputElement;

    fireEvent.input(input, { target: { value: "action" } });
    expect(lines()).toEqual([]);
    fireEvent.input(input, { target: { value: "waves" } });
    expect(lines().map((row) => row.dataset.kind)).toEqual(["action"]);
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

  // Mobile: the rail is a drawer over the pane, and a dialog opens behind it
  // when the peer asks while it is up.
  it("says each time a dialog over the body opens: the emoji comparison's, the badge's key", () => {
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

    setSas(null);
    setTrust({ master: KEY, verified: false, devices: 1 });
    fireEvent.click(screen.getByTestId("e2e-peer-trust").closest("button") as HTMLButtonElement);
    expect(screen.getByTestId("e2e-key-dialog")).toBeTruthy();
    expect(opened).toHaveBeenCalledTimes(3);
  });
});

// The account's identity for the network is held elsewhere (another device,
// or a wiped browser): never replaced silently. A card in the chat says so
// (vjt's ruling 4) and, since issue 2547, says WHY and what grappa holds,
// then leads to pairing this browser; a new identity stays behind a
// disclosure and a confirmation that names what it destroys. Nothing can be
// sent meanwhile, and the rail can act on nothing.
describe("EncryptedChatPane, an identity held elsewhere", () => {
  it("says why, offers pairing first and a new identity only behind a disclosure, and keeps compose shut", () => {
    setTrust({ master: KEY, verified: false, devices: 1 });
    setElsewhere("no-keys");
    renderPane();

    const why = screen.getByTestId("e2e-identity-elsewhere");
    expect(why.dataset.reason).toBe("no-keys");
    expect(why.textContent).toContain("this browser holds no keys");
    expect(within("e2e-step").dataset.step).toBe("elsewhere");
    expect(screen.getByTestId("e2e-rail-elsewhere")).toBeTruthy();
    // Issue 2549: pairing starts on the device that holds the identity and is
    // accepted here from the banner; there is no link to paste.
    const how = screen.getByTestId("e2e-identity-pair-how");
    expect(how.textContent).toContain("pair this browser with a device that holds it");
    expect(how.textContent).toContain('"add a device"');
    expect(how.textContent).toContain('"Pair this browser"');
    expect(within("e2e-step").querySelector("input")).toBeNull();
    // The new identity sits in a disclosure that starts closed, after the
    // pairing guidance: the other way, not the first one.
    const replace = screen.getByTestId("e2e-identity-replace");
    const other = replace.closest("details");
    expect(other).not.toBeNull();
    expect(other?.open).toBe(false);
    expect(within("e2e-step").contains(other)).toBe(true);
    expect(other?.querySelector("summary")).toBe(screen.getByTestId("e2e-identity-other-way"));
    expect(screen.getByTestId("e2e-identity-other-way").textContent).toBe(
      "none of your devices can pair this browser",
    );
    expect(how.compareDocumentPosition(other as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(replace.textContent).toBe("start a new identity here");
    // Nothing that needs the identity: no key to copy or verify, no SAS.
    expect(screen.queryByTestId("e2e-own-identity")).toBeNull();
    expect(screen.queryByTestId("e2e-peer-verify")).toBeNull();
    expect(screen.getByTestId("e2e-peer-trust").closest("button")).toBeNull();
    expect(composeShut()).toBe(true);
  });

  it("says, for each reason the sync found, its own why", () => {
    const anchors: Record<ElsewhereReason, string> = {
      "no-keys": "this browser holds no keys",
      replaced: "was replaced on another device",
      "left-out": "no longer one of the devices",
      "no-list": "no longer holds the list",
    };
    for (const reason of Object.keys(anchors) as ElsewhereReason[]) {
      setElsewhere(reason);
      const { unmount } = renderPane();
      const why = screen.getByTestId("e2e-identity-elsewhere");

      expect(why.dataset.reason).toBe(reason);
      expect(why.textContent).toBe(ELSEWHERE_WHY[reason]);
      expect(why.textContent).toContain(anchors[reason]);
      unmount();
    }
    expect(new Set(Object.values(ELSEWHERE_WHY)).size).toBe(4);
  });

  it("says how many devices grappa lists for the identity, and when one was last active", async () => {
    // 4h 12m and a few seconds ago: the line reads the same for a minute.
    const lastActive = new Date(Date.now() - (4 * 3600 + 12 * 60 + 5) * 1000).toISOString();
    identityDevices.mockResolvedValue({ listed: 2, lastActive });
    setElsewhere("no-keys");
    renderPane();

    expect((await screen.findByTestId("e2e-identity-devices")).textContent).toBe(
      "grappa lists 2 of your devices, one active 4h 12m ago",
    );
    expect(identityDevices).toHaveBeenCalledWith("azzurra");
  });

  it("a devices read grappa refused is logged and leaves the line out, the rest of the card stays", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const refused = new ApiError(503, "unavailable");
    identityDevices.mockRejectedValue(refused);
    setElsewhere("no-keys");
    renderPane();

    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        "[e2e] could not read the devices grappa holds on azzurra",
        refused,
      ),
    );
    expect(screen.queryByTestId("e2e-identity-devices")).toBeNull();
    expect(screen.getByTestId("e2e-identity-pair-how")).toBeTruthy();
    expect(screen.getByTestId("e2e-identity-replace")).toBeTruthy();
    warn.mockRestore();
  });

  it("shuts the compose box on what was typed before, and opens it again once the network reads ready", () => {
    renderPane();
    type("typed");
    expect(composeShut()).toBe(false);
    setElsewhere("no-keys");

    expect(composeShut()).toBe(true);
    expect(composer().value).toBe("typed");
    setElsewhere(null);
    expect(composeShut()).toBe(false);
  });

  it("offers no control that needs the identity: the alarm's key cannot be taken, the chat cannot be deleted", () => {
    setTrust({ master: KEY, verified: true, devices: 1 });
    setRows([{ kind: "key_alarm", id: "a", at, nick: "Bob", presented: OWN }]);
    setElsewhere("no-keys");
    renderPane();
    const remove = screen.getByTestId("e2e-delete-chat") as HTMLButtonElement;

    expect(screen.queryByTestId("e2e-alarm-accept")).toBeNull();
    expect(screen.queryByTestId("e2e-rail-alarm-accept")).toBeNull();
    expect(remove.disabled).toBe(true);
    fireEvent.click(remove);
    expect(confirmRequest()).toBeNull();
    expect(deleteEncryptedChat).not.toHaveBeenCalled();

    // Once the network reads ready again, they come back.
    setElsewhere(null);
    expect(screen.getByTestId("e2e-alarm-accept")).toBeTruthy();
    expect(screen.getByTestId("e2e-rail-alarm-accept")).toBeTruthy();
    expect(remove.disabled).toBe(false);
  });

  it("a new identity takes two taps, the second naming what it destroys", () => {
    setElsewhere("no-keys");
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
      setElsewhere(null);
    });
    setElsewhere("no-keys");
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
    setElsewhere("no-keys");
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
    setElsewhere("no-keys");
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
    setElsewhere("no-keys");
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

// issue 2547 — the card's line on what grappa holds: the count of devices its
// list names, and how long ago one of them read its inbox.
describe("heldDevicesLine", () => {
  const now = Date.parse("2026-11-05T04:42:30Z");
  const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();

  it("says grappa lists none of the devices when its list names none", () => {
    expect(heldDevicesLine({ listed: 0, lastActive: null }, now)).toBe(
      "grappa lists none of your devices",
    );
  });

  it("names the one device's activity, or only the count when none is known", () => {
    expect(heldDevicesLine({ listed: 1, lastActive: ago(45) }, now)).toBe(
      "grappa lists 1 of your devices, active 45s ago",
    );
    expect(heldDevicesLine({ listed: 1, lastActive: null }, now)).toBe(
      "grappa lists 1 of your devices",
    );
  });

  it("says one of several was active, or only the count when none is known", () => {
    expect(heldDevicesLine({ listed: 3, lastActive: ago(4 * 3600 + 12 * 60) }, now)).toBe(
      "grappa lists 3 of your devices, one active 4h 12m ago",
    );
    expect(heldDevicesLine({ listed: 2, lastActive: null }, now)).toBe(
      "grappa lists 2 of your devices",
    );
  });

  it("drops an activity it cannot read rather than guess one", () => {
    expect(heldDevicesLine({ listed: 2, lastActive: "not a time" }, now)).toBe(
      "grappa lists 2 of your devices",
    );
  });
});
