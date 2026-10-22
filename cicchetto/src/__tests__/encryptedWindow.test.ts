import { beforeEach, describe, expect, it, vi } from "vitest";

// issue 2430 — the encrypted window's doors. The chat glue and the selection
// are the boundaries: spies here.

const openEncryptedChat = vi.hoisted(() => vi.fn());
const closeEncryptedChat = vi.hoisted(() => vi.fn());
const setSelectedChannel = vi.hoisted(() => vi.fn());

vi.mock("../lib/encryptedChats", () => ({ openEncryptedChat, closeEncryptedChat }));
vi.mock("../lib/selection", () => ({ setSelectedChannel, selectedChannel: () => null }));

const { closeEncryptedWindow, openEncryptedWindow } = await import("../lib/encryptedWindow");

beforeEach(() => {
  vi.clearAllMocks();
});

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
  it("closes the chat; a failure is said, not thrown at the click", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    closeEncryptedChat.mockRejectedValue(new Error("nope"));

    closeEncryptedWindow("azzurra", "Bob");

    expect(closeEncryptedChat).toHaveBeenCalledWith("azzurra", "Bob");
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });
});
