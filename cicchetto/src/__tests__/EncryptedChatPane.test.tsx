import { Route, Router } from "@solidjs/router";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api";
import type { Chat, ChatRow } from "../lib/e2e/chatStore";
import type { PeerTrust } from "../lib/e2e/client";
import type { SasView } from "../lib/e2e/sas";
import { SAS_EMOJI } from "../lib/e2e/sasEmoji";
import { friendlyApiError } from "../lib/friendlyApiError";

// issue 2430 — the encrypted query pane. The chat glue (lib/encryptedChats)
// is the boundary: its reads are signals here and its verbs are spies, so
// these tests pin what the pane shows and which verb each control reaches.
// `trustOf` stays the real one: the badge is its answer, not a copy of it, as
// do the pairing link helpers (`lib/e2e/pairing.ts`). A key is a master.

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

vi.mock("../lib/encryptedChats", async (importOriginal) => ({
  trustOf: (await importOriginal<typeof import("../lib/encryptedChats")>()).trustOf,
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
}));
vi.mock("../lib/documentVisibility", () => ({ isDocumentVisible: () => visible() }));
vi.mock("../lib/clipboard", () => ({ copyText }));
// jsdom implements no document navigation (and makes `location.assign`
// unforgeable): the one-line seam is mocked, and a test below loads the URL
// it was handed the way the browser would, as a fresh document.
vi.mock("../lib/documentNavigation", () => ({ loadDocument }));

const { default: EncryptedChatPane } = await import("../EncryptedChatPane");
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
  setChat({ nick: "Bob", open: true, unread: 0 });
  setRows([]);
  setTrust(null);
  setOwn(OWN);
  setVisible(true);
  setSas(null);
  setElsewhere(false);
});

const renderPane = () => render(() => <EncryptedChatPane networkSlug="azzurra" nick="bob" />);

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

    setTrust({ master: KEY, verified: true, devices: 1 });
    setRows([{ kind: "pinned", id: "p", at, nick: "Bob", ed25519: KEY }]);
    expect(badge.dataset.trust).toBe("verified");
    expect(screen.getByTestId("e2e-peer-key").textContent).toBe(KEY);

    setRows([
      { kind: "pinned", id: "p", at, nick: "Bob", ed25519: KEY },
      { kind: "key_alarm", id: "a", at, nick: "Bob", presented: OWN },
    ]);
    expect(badge.dataset.trust).toBe("alarm");
  });

  it("shows every row kind, each marked encrypted", () => {
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
      "key_alarm",
      "pinned",
      "accepted",
      "sas_asked",
      "sas_asked",
      "sas_cancelled",
      "sas_cancelled",
      "verified",
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
    expect(shown[6]?.textContent).toContain(OWN);
    expect(shown[7]?.textContent).toContain(`you pinned Bob to ${KEY}`);
    expect(shown[8]?.textContent).toContain(`you took ${KEY} as Bob's key, not verified`);
    expect(shown[9]?.textContent).toContain("you asked Bob to compare emoji");
    expect(shown[10]?.textContent).toContain("Bob asked to compare emoji with you");
    expect(shown[11]?.textContent).toContain(
      "the emoji comparison stopped: no answer in 10 minutes",
    );
    expect(shown[12]?.textContent).toContain('Bob stopped the emoji comparison: "its own words"');
    expect(shown[13]?.textContent).toContain(`you verified Bob's key ${KEY} by comparing emoji`);
  });

  it("the alarm offers to take the new key, unverified, until it is the pinned one", () => {
    setTrust({ master: KEY, verified: true, devices: 1 });
    setRows([{ kind: "key_alarm", id: "a", at, nick: "Bob", presented: OWN }]);
    renderPane();

    fireEvent.click(screen.getByTestId("e2e-alarm-accept"));
    expect(pinEncryptedKey).toHaveBeenCalledWith("azzurra", "bob", OWN, false);

    setTrust({ master: OWN, verified: false, devices: 1 });
    expect(screen.queryByTestId("e2e-alarm-accept")).toBeNull();
  });

  it("offers an emoji comparison for a key not verified, and none for a verified key or no key", () => {
    renderPane();
    expect(screen.queryByTestId("e2e-sas-start")).toBeNull();

    setTrust({ master: KEY, verified: false, devices: 1 });
    fireEvent.click(screen.getByTestId("e2e-sas-start"));
    expect(verifyEncrypted).toHaveBeenCalledWith("azzurra", "bob", "start");

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
    const panel = screen.getByTestId("e2e-sas");
    expect(panel.dataset.phase).toBe(phase);
    expect(panel.textContent).toContain(text);
    expect(screen.queryByTestId("e2e-sas-start")).toBeNull();

    fireEvent.click(screen.getByTestId("e2e-sas-cancel"));
    expect(verifyEncrypted).toHaveBeenCalledWith("azzurra", "bob", "cancel");
  });

  it("a request is accepted from the panel", () => {
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

  it("a message written with another key than the nick's pinned one says so", () => {
    setTrust({ master: KEY, verified: true, devices: 1 });
    setRows([
      { kind: "in", id: "1", at, nick: "Bob", ed25519: KEY, body: "from the pinned key" },
      { kind: "in", id: "2", at, nick: "Bob", ed25519: OWN, body: "from another" },
    ]);
    renderPane();
    const [pinned, other] = screen.getAllByTestId("e2e-row");
    expect(pinned?.querySelector("[data-testid=e2e-row-other-key]")).toBeNull();
    expect(other?.querySelector("[data-testid=e2e-row-other-key]")?.textContent).toBe(
      `written with another key: ${OWN}`,
    );
  });

  it("shows the master the peer's nick is pinned to, and how many of its devices are trusted", () => {
    renderPane();
    expect(screen.getByTestId("e2e-peer-key").textContent).toBe("none yet");
    expect(screen.queryByTestId("e2e-peer-devices")).toBeNull();

    setTrust({ master: KEY, verified: false, devices: 2 });
    expect(screen.getByTestId("e2e-peer-key").textContent).toBe(KEY);
    expect(screen.getByTestId("e2e-peer-devices").textContent).toBe(" (2 devices)");

    setTrust({ master: KEY, verified: false, devices: 1 });
    expect(screen.getByTestId("e2e-peer-devices").textContent).toBe(" (1 device)");
  });

  it("shows our own key, our master, and copies it", async () => {
    renderPane();
    expect(screen.getByTestId("e2e-own-identity").textContent).toBe(OWN);
    fireEvent.click(screen.getByTestId("e2e-own-identity-copy"));
    expect(copyText).toHaveBeenCalledWith(OWN);
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
    fireEvent.input(input, { target: { value: `  ${KEY}\n` } });
    fireEvent.click(screen.getByTestId("e2e-pin-submit"));

    await vi.waitFor(() => expect(input.value).toBe(""));
    expect(pinEncryptedKey).toHaveBeenCalledWith("azzurra", "bob", KEY, true);
    expect(screen.queryByTestId("e2e-pin-error")).toBeNull();
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

  it("searches the messages as typed, any case, notices hidden, counted; Esc shows all again", () => {
    setRows([
      { kind: "in", id: "1", at, nick: "Bob", ed25519: KEY, body: "Ciao, the CODES are ready" },
      { kind: "out", id: "2", at, body: "which codes?", state: "sent", reason: null },
      { kind: "pinned", id: "3", at, nick: "Bob", ed25519: KEY },
      { kind: "in", id: "4", at, nick: "Bob", ed25519: KEY, body: "never mind" },
      { kind: "undecryptable", id: "5", at, nick: "Bob" },
    ]);
    renderPane();
    const input = screen.getByTestId("e2e-search-input") as HTMLInputElement;
    const shown = () => screen.getAllByTestId("e2e-row").map((r) => r.dataset.rowKind);
    expect(screen.queryByTestId("e2e-search-count")).toBeNull();

    fireEvent.input(input, { target: { value: " codes " } });
    expect(shown()).toEqual(["in", "out"]);
    expect(screen.getByTestId("e2e-search-count").textContent).toBe("2 of 3 messages");

    fireEvent.input(input, { target: { value: "nothing like it" } });
    expect(screen.queryAllByTestId("e2e-row")).toEqual([]);
    expect(screen.getByTestId("e2e-search-count").textContent).toBe("0 of 3 messages");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
    expect(shown()).toEqual(["in", "out", "pinned", "in", "undecryptable"]);
    expect(screen.queryByTestId("e2e-search-count")).toBeNull();
  });

  it("deletes the chat on the second tap only: the first arms the button", () => {
    renderPane();
    const button = screen.getByTestId("e2e-delete-chat");
    expect(button.textContent).toBe("delete this chat");

    fireEvent.click(button);
    expect(button.textContent).toBe("really delete?");
    expect(deleteEncryptedChat).not.toHaveBeenCalled();

    fireEvent.click(button);
    expect(deleteEncryptedChat).toHaveBeenCalledWith("azzurra", "bob");
    expect(button.textContent).toBe("delete this chat");
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
// or a wiped browser): never replaced silently. The window says so, offers
// pairing this browser first, then a new identity behind a confirmation that
// names what it destroys; nothing can be sent meanwhile.
describe("EncryptedChatPane, an identity held elsewhere", () => {
  const LINK = `https://grappa.example/pair#pair=${"r".repeat(22)}.${"c".repeat(43)}`;

  it("says the identity is held elsewhere, offers both ways out, and keeps compose shut", () => {
    setTrust({ master: KEY, verified: false, devices: 1 });
    setElsewhere(true);
    renderPane();

    expect(screen.getByTestId("e2e-identity-elsewhere").textContent).toContain(
      "lives on another device, or was lost",
    );
    expect(screen.getByTestId("e2e-identity-pair-code")).toBeTruthy();
    expect(screen.getByTestId("e2e-identity-pair-submit")).toBeTruthy();
    expect(screen.getByTestId("e2e-identity-replace").textContent).toBe(
      "start a new identity here",
    );
    // Nothing that needs the identity: no key to copy or pin, no SAS.
    expect(screen.queryByTestId("e2e-own-identity")).toBeNull();
    expect(screen.queryByTestId("e2e-pin-input")).toBeNull();
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
    expect(remove.disabled).toBe(true);
    fireEvent.click(remove);
    fireEvent.click(remove);
    expect(deleteEncryptedChat).not.toHaveBeenCalled();

    // Once the network reads ready again, both come back.
    setElsewhere(false);
    expect(screen.getByTestId("e2e-alarm-accept")).toBeTruthy();
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
        <Route path="/" component={() => <EncryptedChatPane networkSlug="azzurra" nick="bob" />} />
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
