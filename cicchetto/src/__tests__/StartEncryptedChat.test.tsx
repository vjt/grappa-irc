import { render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// issue 2486 — the query rail's one button to an encrypted chat. The
// requests mirror is real (the button reads whether our asking waits); the
// asking itself is a spy, and fetch is stubbed so that "nothing is sent
// before the confirm" is measured at the network, not only at the spy.

const askEncryptedChat = vi.hoisted(() => vi.fn());
const openEncryptedWindow = vi.hoisted(() => vi.fn());
// issue 2508 — the device's chat index, as a signal: whether an encrypted chat
// with the peer exists is what the button reads, and it can change under it.
const chats = vi.hoisted(() => ({
  get: (
    _slug: string,
    _nick: string,
  ): { nick: string; open: boolean; unread: number } | undefined => undefined,
}));

vi.mock("../lib/e2eRequests", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/e2eRequests")>()),
  askEncryptedChat,
}));
vi.mock("../lib/encryptedChats", () => ({
  askEncryptedKeys: vi.fn(),
  encryptedChat: (slug: string, nick: string) => chats.get(slug, nick),
  encryptedDevice: vi.fn(),
  openEncryptedChat: vi.fn(),
}));
vi.mock("../lib/encryptedWindow", () => ({ openEncryptedWindow }));
vi.mock("../lib/auth", () => ({ token: () => "tok" }));
vi.mock("../lib/networks", () => ({ networks: () => [] }));
vi.mock("../lib/selection", () => ({ selectedChannel: () => null }));

const { ApiError } = await import("../lib/api");
const { acceptConfirm, confirmRequest, dismissConfirm } = await import("../lib/confirmDialog");
const { dropE2eRequest, putE2eRequest } = await import("../lib/e2eRequests");
const { errorMessage } = await import("../lib/friendlyApiError");
const { default: StartEncryptedChat, startEncryptedChatBody } = await import(
  "../StartEncryptedChat"
);

let fetchSpy: ReturnType<typeof vi.fn>;

const button = () => screen.getByTestId("rail-start-encrypted-chat") as HTMLButtonElement;
const show = () => render(() => <StartEncryptedChat networkSlug="azzurra" peer="Bob" />);

beforeEach(() => {
  askEncryptedChat.mockReset();
  askEncryptedChat.mockResolvedValue(undefined);
  openEncryptedWindow.mockReset();
  openEncryptedWindow.mockResolvedValue(undefined);
  chats.get = () => undefined;
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  dismissConfirm();
  dropE2eRequest("azzurra", 1);
  vi.unstubAllGlobals();
});

describe("StartEncryptedChat", () => {
  it("asks first, Cancel the default, saying what the peer needs and how long it waits; nothing is sent yet", () => {
    show();

    button().click();

    expect(confirmRequest()).toMatchObject({
      title: "Start encrypted chat",
      body: startEncryptedChatBody("Bob"),
      confirmLabel: "Ask",
      defaultButton: "cancel",
    });
    expect(startEncryptedChatBody("Bob")).toMatch(/cicchetto/);
    expect(startEncryptedChatBody("Bob")).toMatch(/24 hours/);
    expect(askEncryptedChat).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("Ask sends the asking to the peer", () => {
    show();
    button().click();

    acceptConfirm();

    expect(askEncryptedChat).toHaveBeenCalledWith("azzurra", "Bob");
  });

  it("Cancel sends nothing", () => {
    show();
    button().click();

    dismissConfirm();

    expect(askEncryptedChat).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("while our asking waits the button says so, and cannot ask twice", () => {
    putE2eRequest("azzurra", {
      id: 1,
      peer: "bob",
      state: "outgoing",
      payload: null,
      at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    show();

    expect(button().disabled).toBe(true);
    expect(button().textContent).toBe("encrypted chat requested");
  });

  it("while the asking is on its way the button cannot ask again, and can once grappa answered", async () => {
    let answer: () => void = () => undefined;
    askEncryptedChat.mockReturnValueOnce(new Promise<void>((resolve) => (answer = resolve)));
    show();
    button().click();
    acceptConfirm();

    expect(button().disabled).toBe(true);
    button().click();
    expect(confirmRequest()).toBeNull();

    answer();
    await vi.waitFor(() => expect(button().disabled).toBe(false));
    expect(askEncryptedChat).toHaveBeenCalledTimes(1);
  });

  it("the query switched to another peer starts clean: no error and no asking held from the last", async () => {
    askEncryptedChat.mockRejectedValueOnce(new ApiError(422, "requests_full"));
    askEncryptedChat.mockReturnValueOnce(new Promise(() => undefined));
    const [peer, setPeer] = createSignal("Bob");
    render(() => <StartEncryptedChat networkSlug="azzurra" peer={peer()} />);

    button().click();
    acceptConfirm();
    await vi.waitFor(() =>
      expect(screen.queryByTestId("rail-start-encrypted-chat-error")).not.toBeNull(),
    );
    setPeer("Carol");
    expect(screen.queryByTestId("rail-start-encrypted-chat-error")).toBeNull();

    button().click();
    acceptConfirm();
    setPeer("Dave");
    expect(button().disabled).toBe(false);
  });

  it("an asking grappa refuses is said under the button", async () => {
    const refusal = new ApiError(422, "requests_full");
    askEncryptedChat.mockRejectedValue(refusal);
    show();
    button().click();

    acceptConfirm();

    await vi.waitFor(() =>
      expect(screen.getByTestId("rail-start-encrypted-chat-error").textContent).toBe(
        errorMessage(refusal),
      ),
    );
  });
  it("with an encrypted chat with the peer already here, the button says chat securely and opens it: no confirm, nothing asked", () => {
    chats.get = (slug, nick) =>
      slug === "azzurra" && nick === "Bob" ? { nick: "bob", open: false, unread: 0 } : undefined;
    show();

    const securely = screen.getByTestId("rail-chat-securely") as HTMLButtonElement;
    expect(securely.textContent).toBe("chat securely");
    expect(screen.queryByTestId("rail-start-encrypted-chat")).toBeNull();

    securely.click();

    // The window the chat index names, spelled as the index has it.
    expect(openEncryptedWindow).toHaveBeenCalledWith("azzurra", "bob");
    expect(confirmRequest()).toBeNull();
    expect(askEncryptedChat).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("an encrypted chat that comes to exist while the rail is up turns the button into chat securely", () => {
    const [exists, setExists] = createSignal(false);
    chats.get = () => (exists() ? { nick: "Bob", open: true, unread: 0 } : undefined);
    show();
    expect(button().textContent).toBe("start encrypted chat");

    setExists(true);

    expect(screen.getByTestId("rail-chat-securely").textContent).toBe("chat securely");
    expect(screen.queryByTestId("rail-start-encrypted-chat")).toBeNull();
  });

  it("a chat that could not be opened is said under the button", async () => {
    chats.get = () => ({ nick: "Bob", open: false, unread: 0 });
    openEncryptedWindow.mockRejectedValue(new Error("the chat index is not readable"));
    show();

    screen.getByTestId("rail-chat-securely").click();

    await vi.waitFor(() =>
      expect(screen.getByTestId("rail-start-encrypted-chat-error").textContent).toBe(
        errorMessage(new Error("the chat index is not readable")),
      ),
    );
  });
  it("a chat that comes to exist while the confirm is open: Ask opens it and asks nothing", () => {
    const [exists, setExists] = createSignal(false);
    chats.get = () => (exists() ? { nick: "Bob", open: false, unread: 0 } : undefined);
    show();
    button().click();
    expect(confirmRequest()).not.toBeNull();

    setExists(true);
    acceptConfirm();

    expect(askEncryptedChat).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(openEncryptedWindow).toHaveBeenCalledWith("azzurra", "Bob");
  });

  it("an asking's error does not follow the button once the chat exists", async () => {
    askEncryptedChat.mockRejectedValueOnce(new ApiError(422, "requests_full"));
    const [exists, setExists] = createSignal(false);
    chats.get = () => (exists() ? { nick: "Bob", open: false, unread: 0 } : undefined);
    show();
    button().click();
    acceptConfirm();
    await vi.waitFor(() =>
      expect(screen.queryByTestId("rail-start-encrypted-chat-error")).not.toBeNull(),
    );

    setExists(true);

    expect(screen.getByTestId("rail-chat-securely").textContent).toBe("chat securely");
    expect(screen.queryByTestId("rail-start-encrypted-chat-error")).toBeNull();
  });
});
