import { render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// issue 2486 — the query rail's one button to an encrypted chat. The
// requests mirror is real (the button reads whether our asking waits); the
// asking itself is a spy, and fetch is stubbed so that "nothing is sent
// before the confirm" is measured at the network, not only at the spy.

const askEncryptedChat = vi.hoisted(() => vi.fn());

vi.mock("../lib/e2eRequests", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/e2eRequests")>()),
  askEncryptedChat,
}));
vi.mock("../lib/encryptedChats", () => ({
  askEncryptedKeys: vi.fn(),
  encryptedDevice: vi.fn(),
  openEncryptedChat: vi.fn(),
}));
vi.mock("../lib/encryptedWindow", () => ({ openEncryptedWindow: vi.fn() }));
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

  it("an asking grappa refuses is said under the button", async () => {
    const refusal = new ApiError(429, "requests_full");
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
});
