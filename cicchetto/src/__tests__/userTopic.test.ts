import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type EventHandler = (payload: { kind: string; [k: string]: unknown }) => void;

const channelMock = vi.hoisted(() => {
  const handlers: EventHandler[] = [];
  return {
    handlers,
    on: vi.fn((event: string, fn: EventHandler) => {
      if (event === "event") handlers.push(fn);
    }),
    fireEvent: (payload: { kind: string; [k: string]: unknown }) => {
      for (const h of handlers) h(payload);
    },
    reset: () => {
      handlers.length = 0;
    },
  };
});

vi.mock("../lib/socket", () => ({
  joinUser: vi.fn(() => ({ on: channelMock.on })),
  joinChannel: vi.fn(),
}));

vi.mock("../lib/networks", () => ({
  user: vi.fn(() => ({ kind: "user", id: "u1", name: "vjt", inserted_at: "x" })),
  refetchChannels: vi.fn(),
  networks: vi.fn(() => []),
  channelsBySlug: vi.fn(() => ({})),
}));

vi.mock("../lib/auth", () => ({
  token: vi.fn(() => "t1"),
  socketUserName: vi.fn(() => "vjt"),
}));

describe("userTopic", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    channelMock.reset();
    // Re-import to trigger the createRoot side-effect anew per test.
    vi.resetModules();
    await import("../lib/userTopic");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("joins the user topic when user resolves", async () => {
    const socket = await import("../lib/socket");
    expect(socket.joinUser).toHaveBeenCalledWith("vjt");
  });

  it("calls refetchChannels on channels_changed event", async () => {
    const networks = await import("../lib/networks");
    channelMock.fireEvent({ kind: "channels_changed" });
    expect(networks.refetchChannels).toHaveBeenCalled();
  });

  it("does NOT call refetchChannels on unrelated event payloads", async () => {
    const networks = await import("../lib/networks");
    channelMock.fireEvent({ kind: "message", body: "hi" });
    expect(networks.refetchChannels).not.toHaveBeenCalled();
  });
});
