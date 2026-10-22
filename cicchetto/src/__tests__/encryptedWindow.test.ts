import { beforeEach, describe, expect, it, vi } from "vitest";

// issue 2430 — the encrypted window's doors. The chat glue and the selection
// are the boundaries: spies here.

const openEncryptedChat = vi.hoisted(() => vi.fn());
const closeEncryptedChat = vi.hoisted(() => vi.fn());
const deleteEncryptedChat = vi.hoisted(() => vi.fn());
const encryptedChatHasRows = vi.hoisted(() => vi.fn());
const setSelectedChannel = vi.hoisted(() => vi.fn());

vi.mock("../lib/encryptedChats", () => ({
  openEncryptedChat,
  closeEncryptedChat,
  deleteEncryptedChat,
  encryptedChatHasRows,
}));
vi.mock("../lib/selection", () => ({ setSelectedChannel, selectedChannel: () => null }));

const { closeEncryptedWindow, openEncryptedWindow } = await import("../lib/encryptedWindow");
const { acceptConfirm, chooseAlternative, confirmRequest, dismissConfirm } = await import(
  "../lib/confirmDialog"
);

beforeEach(() => {
  vi.clearAllMocks();
  dismissConfirm();
  closeEncryptedChat.mockResolvedValue(undefined);
  deleteEncryptedChat.mockResolvedValue(undefined);
});

// The × with a chat that has rows: the question it asks.
async function asked() {
  encryptedChatHasRows.mockResolvedValue(true);
  closeEncryptedWindow("azzurra", "Bob");
  await vi.waitFor(() => expect(confirmRequest()).not.toBeNull());
  return confirmRequest();
}

describe("openEncryptedWindow", () => {
  it("opens the chat, then focuses its window, named for the nick as given", async () => {
    openEncryptedChat.mockResolvedValue(undefined);

    await openEncryptedWindow("azzurra", "Bob");

    expect(openEncryptedChat).toHaveBeenCalledWith("azzurra", "Bob");
    expect(setSelectedChannel).toHaveBeenCalledWith({
      networkSlug: "azzurra",
      channelName: "$e2e:Bob",
      kind: "encrypted",
    });
  });

  it("a chat the device could not open gets no window", async () => {
    openEncryptedChat.mockRejectedValue(new Error("IndexedDB is gone"));

    await expect(openEncryptedWindow("azzurra", "Bob")).rejects.toThrow("IndexedDB is gone");
    expect(setSelectedChannel).not.toHaveBeenCalled();
  });
});

describe("closeEncryptedWindow", () => {
  it("closes a chat with no rows without asking; a failure is said, not thrown at the click", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    encryptedChatHasRows.mockResolvedValue(false);
    closeEncryptedChat.mockRejectedValue(new Error("nope"));

    closeEncryptedWindow("azzurra", "Bob");

    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(encryptedChatHasRows).toHaveBeenCalledWith("azzurra", "Bob");
    expect(closeEncryptedChat).toHaveBeenCalledWith("azzurra", "Bob");
    expect(confirmRequest()).toBeNull();
    warn.mockRestore();
  });

  it("asks about a chat with rows, Cancel first: delete them (the red yes), or keep them", async () => {
    const req = await asked();

    expect(req).toMatchObject({
      title: "Close encrypted query",
      confirmLabel: "Delete",
      alternative: { label: "Keep" },
      defaultButton: "cancel",
    });
    expect(req?.body).toContain("Bob");
    expect(closeEncryptedChat).not.toHaveBeenCalled();
    expect(deleteEncryptedChat).not.toHaveBeenCalled();
  });

  it("Keep closes the chat and deletes nothing", async () => {
    await asked();

    chooseAlternative();

    expect(closeEncryptedChat).toHaveBeenCalledWith("azzurra", "Bob");
    expect(deleteEncryptedChat).not.toHaveBeenCalled();
  });

  it("Delete deletes the chat", async () => {
    await asked();

    acceptConfirm();

    expect(deleteEncryptedChat).toHaveBeenCalledWith("azzurra", "Bob");
    expect(closeEncryptedChat).not.toHaveBeenCalled();
  });

  it("Cancel neither closes nor deletes", async () => {
    await asked();

    dismissConfirm();

    expect(closeEncryptedChat).not.toHaveBeenCalled();
    expect(deleteEncryptedChat).not.toHaveBeenCalled();
  });

  it("a delete that fails is said, not thrown at the click", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    deleteEncryptedChat.mockRejectedValue(new Error("IndexedDB is gone"));
    await asked();

    acceptConfirm();

    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });
});
