import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat, ChatRow } from "../lib/e2e/chatStore";
import type { PeerTrust } from "../lib/e2e/client";

// issue 2430 — the encrypted query pane. The chat glue (lib/encryptedChats)
// is the boundary: its reads are signals here and its verbs are spies, so
// these tests pin what the pane shows and which verb each control reaches.
// `trustOf` stays the real one: the badge is its answer, not a copy of it.

const KEY = "J2bCqN5ukKUq1qDNgzWbn9GZ7xjzM2bA0f9yqkvq0Ss";
const OWN = "7hPz0kdkCq0cH1L2oW9i3l0gq3uM8V8vxa5w8Kq2yYk";

const [chat, setChat] = createSignal<Chat | undefined>(undefined);
const [rows, setRows] = createSignal<ChatRow[] | undefined>(undefined);
const [trust, setTrust] = createSignal<PeerTrust | null>(null);
const [own, setOwn] = createSignal<string | undefined>(undefined);
const [visible, setVisible] = createSignal(true);

const loadEncryptedChat = vi.hoisted(() => vi.fn());
const readEncryptedChat = vi.hoisted(() => vi.fn());
const sendEncrypted = vi.hoisted(() => vi.fn());
const pinEncryptedKey = vi.hoisted(() => vi.fn());
const copyText = vi.hoisted(() => vi.fn());

vi.mock("../lib/encryptedChats", async (importOriginal) => ({
  trustOf: (await importOriginal<typeof import("../lib/encryptedChats")>()).trustOf,
  encryptedChat: () => chat(),
  encryptedRows: () => rows(),
  encryptedTrust: () => trust(),
  ownKey: () => own(),
  loadEncryptedChat,
  readEncryptedChat,
  sendEncrypted,
  pinEncryptedKey,
}));
vi.mock("../lib/documentVisibility", () => ({ isDocumentVisible: () => visible() }));
vi.mock("../lib/clipboard", () => ({ copyText }));

const { default: EncryptedChatPane } = await import("../EncryptedChatPane");

const at = 1_700_000_000_000;

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of [loadEncryptedChat, readEncryptedChat, sendEncrypted, copyText]) {
    fn.mockResolvedValue(undefined);
  }
  pinEncryptedKey.mockResolvedValue("pinned");
  setChat({ nick: "Bob", open: true, unread: 0 });
  setRows([]);
  setTrust(null);
  setOwn(OWN);
  setVisible(true);
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

    setTrust({ ed25519: KEY, verified: true });
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
      { kind: "undecryptable", id: "5", at, nick: "Bob" },
      { kind: "key_alarm", id: "6", at, nick: "Bob", presented: OWN },
      { kind: "pinned", id: "7", at, nick: "Bob", ed25519: KEY },
    ]);
    renderPane();
    const shown = screen.getAllByTestId("e2e-row");
    expect(shown.map((r) => r.dataset.rowKind)).toEqual([
      "in",
      "out",
      "out",
      "out",
      "undecryptable",
      "key_alarm",
      "pinned",
    ]);
    for (const row of shown) expect(row.querySelector(".encrypted-marker")).not.toBeNull();
    expect(shown[0]?.textContent).toContain("ciao");
    expect(shown[1]?.textContent).toContain("waiting for keys");
    expect(shown[2]?.querySelector("[data-testid=e2e-row-state]")?.textContent).toBe("");
    expect(shown[3]?.textContent).toContain("not sent: grappa's queue for this peer is full");
    expect(shown[4]?.textContent).toContain(
      "Bob sent you an encrypted message that cannot be read here",
    );
    expect(shown[5]?.textContent).toContain(OWN);
    expect(shown[6]?.textContent).toContain(`you pinned Bob to ${KEY}`);
  });

  it("a message written with another key than the nick's pinned one says so", () => {
    setTrust({ ed25519: KEY, verified: true });
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

  it("shows our own key and copies it", async () => {
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
    expect(pinEncryptedKey).toHaveBeenCalledWith("azzurra", "bob", KEY);
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

  it("marks what arrives read while the page is visible, and not while it is hidden", () => {
    setVisible(false);
    setChat({ nick: "Bob", open: true, unread: 2 });
    renderPane();
    expect(readEncryptedChat).not.toHaveBeenCalled();

    setVisible(true);
    expect(readEncryptedChat).toHaveBeenCalledWith("azzurra", "bob");
  });
});
