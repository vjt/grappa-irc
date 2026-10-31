import { Route, Router } from "@solidjs/router";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import { acceptConfirm, confirmRequest, dismissConfirm } from "../lib/confirmDialog";
import type { Chat, ChatRow, IdentityCheck } from "../lib/e2e/chatStore";
import type { PeerTrust } from "../lib/e2e/client";
import type { SasView } from "../lib/e2e/sas";
import { SAS_EMOJI } from "../lib/e2e/sasEmoji";
import { friendlyApiError } from "../lib/friendlyApiError";
import { ruleBody, themeCss } from "./helpers/themeCss";

// issue 2430 — the encrypted query window: the pane, and since issue 2485 its
// technical half in the right rail (EncryptedRail), rendered side by side as
// Shell mounts them. The chat glue (lib/encryptedChats) is the boundary: its
// reads are signals here and its verbs are spies, so these tests pin what the
// window shows where, and which verb each control reaches. `trustOf` and
// `openAlarm` stay the real ones: the badge and the step are their answers,
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
const copyText = vi.hoisted(() => vi.fn());
const loadDocument = vi.hoisted(() => vi.fn());
const holdsMasterHere = vi.hoisted(() => vi.fn());
const panel = vi.hoisted(() => ({
  onClose: null as null | (() => void),
  mounted: 0,
  unmounted: 0,
}));

vi.mock("../lib/encryptedChats", async (importOriginal) => ({
  trustOf: (await importOriginal<typeof import("../lib/encryptedChats")>()).trustOf,
  openAlarm: (await importOriginal<typeof import("../lib/encryptedChats")>()).openAlarm,
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
  pairedHere: vi.fn(),
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
vi.mock("../lib/clipboard", () => ({ copyText }));
// jsdom implements no document navigation (and makes `location.assign`
// unforgeable): the one-line seam is mocked, and a test below loads the URL
// it was handed the way the browser would, as a fresh document.
vi.mock("../lib/documentNavigation", () => ({ loadDocument }));

const { default: EncryptedChatPane } = await import("../EncryptedChatPane");
const { default: EncryptedRail } = await import("../EncryptedRail");
const { default: PairScan } = await import("../PairScan");

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
});

const Pane = () => (
  <EncryptedChatPane
    networkSlug="azzurra"
    nick="bob"
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

describe("EncryptedChatPane", () => {
  it("loads the chat it shows, and names the peer as the chat spells it", () => {
    renderPane();
    expect(loadEncryptedChat).toHaveBeenCalledWith("azzurra", "bob");
    expect(screen.getByTestId("e2e-compose-input").getAttribute("placeholder")).toBe(
      "encrypted message to Bob",
    );
  });

  it("the trust badge: not verified, then verified once pinned, then an alarm after it", () => {
    renderPane();
    const badge = screen.getByTestId("e2e-peer-trust");
    expect(badge.dataset.trust).toBe("unverified");
    expect(badge.textContent).toBe("not verified");

    setTrust({ master: KEY, verified: true, devices: 1 });
    setRows([{ kind: "pinned", id: "p", at, nick: "Bob", ed25519: KEY }]);
    expect(badge.dataset.trust).toBe("verified");
    expect(screen.getByTestId("e2e-rail-trust").dataset.trust).toBe("verified");

    setRows([
      { kind: "pinned", id: "p", at, nick: "Bob", ed25519: KEY },
      { kind: "key_alarm", id: "a", at, nick: "Bob", presented: OWN },
    ]);
    expect(badge.dataset.trust).toBe("alarm");
    expect(badge.textContent).toBe("key changed");
  });

  it("the top bar is verification only: no key, no pin form, no device, no comparison button", () => {
    setTrust({ master: KEY, verified: false, devices: 2 });
    setRows([{ kind: "accepted", id: "p", at, nick: "Bob", ed25519: KEY }]);
    renderPane();
    const bar = screen.getByTestId("e2e-pane").querySelector("header") as HTMLElement;

    expect(bar.textContent).not.toContain(KEY);
    expect(bar.textContent).not.toContain(OWN);
    expect(bar.querySelector("input")).toBeNull();
    expect(bar.querySelector("[data-testid=e2e-sas-start]")).toBeNull();
    expect(bar.querySelector("[data-testid=e2e-sas]")).toBeNull();
    // What it does carry: the badge and the chat's two tools.
    expect(bar.querySelector("[data-testid=e2e-peer-trust]")).not.toBeNull();
    expect(bar.querySelector("[data-testid=e2e-search-toggle]")).not.toBeNull();
    expect(bar.querySelector("[data-testid=e2e-delete-chat]")).not.toBeNull();
  });

  it("shows the messages, each marked encrypted, and none of the key events the store keeps", () => {
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
    const shown = screen.getAllByTestId("e2e-row");
    expect(shown.map((r) => r.dataset.rowKind)).toEqual([
      "in",
      "out",
      "out",
      "out",
      "out",
      "undecryptable",
    ]);
    for (const row of shown) expect(row.querySelector(".encrypted-marker")).not.toBeNull();
    expect(shown[0]?.textContent).toContain("ciao");
    expect(shown[1]?.textContent).toContain("waiting for keys");
    expect(shown[2]?.querySelector("[data-testid=e2e-row-state]")?.textContent).toBe("");
    expect(shown[3]?.textContent).toContain("not sent: grappa's queue for this peer is full");
    expect(shown[4]?.textContent).toContain(
      "not sent: the network is not connected yet, so it could not be sized",
    );
    expect(shown[5]?.textContent).toContain(
      "Bob sent you an encrypted message that cannot be read here",
    );
    const list = screen.getByTestId("e2e-pane").querySelector(".e2e-rows") as HTMLElement;
    expect(list.textContent).not.toContain(KEY);
    expect(list.textContent).not.toContain(OWN);
    // The exchange is done (a pinned key, the alarm answered): no step either.
    expect(screen.queryByTestId("e2e-step")).toBeNull();
  });

  it("a message written with another key than the nick's pinned one is marked, the key in its label", () => {
    setTrust({ master: KEY, verified: true, devices: 1 });
    setRows([
      { kind: "in", id: "1", at, nick: "Bob", ed25519: KEY, body: "from the pinned key" },
      { kind: "in", id: "2", at, nick: "Bob", ed25519: OWN, body: "from another" },
    ]);
    renderPane();
    const [pinned, other] = screen.getAllByTestId("e2e-row");
    expect(pinned?.querySelector("[data-testid=e2e-row-other-key]")).toBeNull();
    expect(
      other?.querySelector("[data-testid=e2e-row-other-key]")?.getAttribute("aria-label"),
    ).toBe(`written with another key: ${OWN}`);
  });
});

// The key exchange is done once the nick has a pinned key and no alarm is
// open, verified or not (vjt's ruling 1). Until then the chat body shows the
// one step still needed, and only that.
describe("EncryptedChatPane, the key-exchange step", () => {
  it("no key yet: says what to do, pins a pasted key and copies ours from the card", async () => {
    renderPane();
    const step = within("e2e-step");
    expect(step.dataset.step).toBe("no-key");
    expect(step.textContent).toContain("no keys exchanged with Bob yet");

    const input = screen.getByTestId("e2e-step-pin-input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: ` ${KEY} ` } });
    fireEvent.click(screen.getByTestId("e2e-step-pin-submit"));
    await vi.waitFor(() => expect(input.value).toBe(""));
    expect(pinEncryptedKey).toHaveBeenCalledWith("azzurra", "bob", KEY, true);

    fireEvent.click(screen.getByTestId("e2e-step-copy"));
    expect(copyText).toHaveBeenCalledWith(OWN);

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

  it("an open alarm: the card pins the key they give you, verified, as the rail does", async () => {
    setTrust({ master: KEY, verified: true, devices: 1 });
    setRows([{ kind: "key_alarm", id: "a", at, nick: "Bob", presented: OWN }]);
    renderPane();

    const input = within("e2e-step").querySelector<HTMLInputElement>(
      "[data-testid='e2e-alarm-pin-input']",
    );
    expect(input).not.toBeNull();
    fireEvent.input(input as HTMLInputElement, { target: { value: KEY } });
    fireEvent.click(screen.getByTestId("e2e-alarm-pin-submit"));

    await vi.waitFor(() =>
      expect(pinEncryptedKey).toHaveBeenCalledWith("azzurra", "bob", KEY, true),
    );
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

// The emoji comparison runs in the chat window, modal-like (vjt's ruling 2):
// started from the rail, it covers the body, and nothing is sent until it ends.
describe("EncryptedChatPane, the emoji comparison", () => {
  it("is offered in the rail for a pinned key not verified, never for no key, a verified key or an open alarm", () => {
    renderPane();
    expect(screen.queryByTestId("e2e-sas-start")).toBeNull();

    setTrust({ master: KEY, verified: false, devices: 1 });
    fireEvent.click(screen.getByTestId("e2e-sas-start"));
    expect(verifyEncrypted).toHaveBeenCalledWith("azzurra", "bob", "start");
    expect(within("e2e-rail").contains(screen.getByTestId("e2e-sas-start"))).toBe(true);

    setRows([{ kind: "key_alarm", id: "a", at, nick: "Bob", presented: OWN }]);
    expect(screen.queryByTestId("e2e-sas-start")).toBeNull();

    setRows([]);
    setTrust({ master: KEY, verified: true, devices: 1 });
    expect(screen.queryByTestId("e2e-sas-start")).toBeNull();
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
    expect(screen.queryByTestId("e2e-sas-start")).toBeNull();

    fireEvent.click(screen.getByTestId("e2e-sas-cancel"));
    expect(verifyEncrypted).toHaveBeenCalledWith("azzurra", "bob", "cancel");
  });

  it("covers the chat body as a dialog: the body is inert and nothing is sent until it ends", () => {
    setTrust({ master: KEY, verified: false, devices: 1 });
    renderPane();
    const input = screen.getByTestId("e2e-compose-input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "not yet" } });
    const content = screen.getByTestId("e2e-compose").parentElement as HTMLElement;
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
    fireEvent.submit(screen.getByTestId("e2e-compose"));
    expect(sendEncrypted).not.toHaveBeenCalled();

    // Over: the draft is still there, and goes.
    setSas(null);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(content.inert).toBe(false);
    fireEvent.submit(screen.getByTestId("e2e-compose"));
    expect(sendEncrypted).toHaveBeenCalledWith("azzurra", "bob", "not yet");
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
  it("sends what was typed through the encrypted door and keeps no draft", () => {
    renderPane();
    const input = screen.getByTestId("e2e-compose-input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "segreto" } });
    fireEvent.click(screen.getByTestId("e2e-compose-send"));

    expect(sendEncrypted).toHaveBeenCalledWith("azzurra", "bob", "segreto");
    expect(input.value).toBe("");
  });

  it("sends nothing blank", () => {
    renderPane();
    fireEvent.input(screen.getByTestId("e2e-compose-input"), { target: { value: "   " } });
    fireEvent.click(screen.getByTestId("e2e-compose-send"));
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
    const shown = () => screen.getAllByTestId("e2e-row").map((r) => r.dataset.rowKind);
    expect(screen.queryByTestId("e2e-search-input")).toBeNull();

    const toggle = screen.getByTestId("e2e-search-toggle");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    const input = screen.getByTestId("e2e-search-input") as HTMLInputElement;
    expect(screen.queryByTestId("e2e-search-count")).toBeNull();

    fireEvent.input(input, { target: { value: " codes " } });
    expect(shown()).toEqual(["in", "out"]);
    expect(screen.getByTestId("e2e-search-count").textContent).toBe("2 of 3 messages");

    fireEvent.input(input, { target: { value: "nothing like it" } });
    expect(screen.queryAllByTestId("e2e-row")).toEqual([]);
    expect(screen.getByTestId("e2e-search-count").textContent).toBe("0 of 3 messages");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByTestId("e2e-search-input")).toBeNull();
    expect(shown()).toEqual(["in", "out", "in", "undecryptable"]);

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
  // it (started from the rail, or asked by the peer while it is up).
  it("says each time the emoji comparison's dialog opens", () => {
    const opened = vi.fn();
    render(() => (
      <EncryptedChatPane
        networkSlug="azzurra"
        nick="bob"
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

  it("marks what arrives read while the page is visible, and not while it is hidden", () => {
    setVisible(false);
    setChat({ nick: "Bob", open: true, unread: 2 });
    renderPane();
    expect(readEncryptedChat).not.toHaveBeenCalled();

    setVisible(true);
    expect(readEncryptedChat).toHaveBeenCalledWith("azzurra", "bob");
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
    expect(screen.queryByTestId("e2e-step-pin-input")).toBeNull();
    expect(screen.queryByTestId("e2e-sas-start")).toBeNull();
    expect((screen.getByTestId("e2e-compose-input") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId("e2e-compose-send") as HTMLButtonElement).disabled).toBe(true);
  });

  it("sends nothing while elsewhere, whatever was typed before", () => {
    renderPane();
    fireEvent.input(screen.getByTestId("e2e-compose-input"), { target: { value: "typed" } });
    setElsewhere(true);

    fireEvent.submit(screen.getByTestId("e2e-compose"));

    expect(sendEncrypted).not.toHaveBeenCalled();
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
    await vi.waitFor(() =>
      expect((screen.getByTestId("e2e-compose-input") as HTMLInputElement).disabled).toBe(false),
    );
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
    expect((screen.getByTestId("e2e-compose-send") as HTMLButtonElement).disabled).toBe(true);
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
