import { beforeEach, describe, expect, it, vi } from "vitest";

// #364 cicchetto S1 — user-topic re-join across the token lifecycle.
//
// The sibling `userTopic.test.ts` mocks `../lib/auth` as plain functions,
// so it can drive the EVENT dispatcher but NOT the reactive token effect
// (a `vi.fn(() => "t1")` never re-runs the createEffect on change). This
// file exercises the REAL `auth.ts` signal — the exact production surface
// rotation rides — so `setToken(...)` fans a genuine reactive update into
// userTopic's join effect.
//
// Boundary: mock the socket helper (assert the join lifecycle) and REST
// (`lib/api`, so the transitive `networks.ts` createResource resolves
// against stubs instead of jsdom's real `fetch`). Everything else —
// auth + the store leaves userTopic imports — is real.
//
// The load-bearing spec is "re-joins on token rotation with UNCHANGED
// identity": socket.ts rebuilds the Socket on every token transition (the
// bearer rides the `authToken` subprotocol, captured once at
// construction), so the prior user-topic Channel is orphaned on a dead
// socket. Pre-fix userTopic dedup'd on the derived IDENTITY and
// early-returned when the name was unchanged — so a rotation never
// re-joined: every user-topic event was lost and every user/channel push
// verb rejected "not connected" until logout+reload.

const mockUserChannel = { on: vi.fn(), leave: vi.fn() };

vi.mock("../lib/socket", () => ({
  joinUser: vi.fn(() => mockUserChannel),
}));

// Mirror of subscribe.test.ts's api mock — the transitive `networks.ts`
// createResource (+ its `tagNetwork`/`ownNickForNetwork` helpers) is the
// only import-time REST surface userTopic pulls in.
vi.mock("../lib/api", () => ({
  listNetworks: vi
    .fn()
    .mockResolvedValue([
      { id: 1, slug: "freenode", nick: "alice", inserted_at: "x", updated_at: "y" },
    ]),
  listChannels: vi.fn().mockResolvedValue([]),
  listMessages: vi.fn().mockResolvedValue([]),
  sendMessage: vi.fn(),
  me: vi.fn().mockResolvedValue({
    kind: "user",
    id: "u1",
    name: "alice",
    is_admin: false,
    inserted_at: "x",
  }),
  login: vi.fn(),
  logout: vi.fn(),
  setOn401Handler: vi.fn(),
  isContentKind: (k: string) => k === "privmsg" || k === "notice" || k === "action",
  isPresenceKind: (k: string) => !(k === "privmsg" || k === "notice" || k === "action"),
  displayNick: (me: { kind: "user" | "visitor"; name?: string; nick?: string }) =>
    me.kind === "user" ? (me.name ?? "") : (me.nick ?? ""),
  ownNickForNetwork: (
    net: { slug: string; nick?: string },
    me: { kind: "user" | "visitor" } | null | undefined,
  ) => {
    if (me == null) return null;
    return net.nick ?? null;
  },
  tagNetwork: (
    raw: {
      kind?: "user" | "visitor";
      id: number;
      slug: string;
      nick?: string;
      connection_state?: string;
    } & Record<string, unknown>,
  ) => {
    const kind = raw.kind ?? "user";
    if (kind === "visitor") {
      return { kind: "visitor", id: raw.id, slug: raw.slug };
    }
    if (raw.nick === undefined || raw.nick === "") return null;
    return {
      kind: "user",
      ...raw,
      connection_state: raw.connection_state ?? "connected",
      connection_state_reason: raw.connection_state_reason ?? null,
      connection_state_changed_at: raw.connection_state_changed_at ?? null,
    };
  },
}));

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.clearAllMocks();
  // vi.clearAllMocks wipes call history but not the joinUser
  // mockImplementation set at declaration; the singleton channel is
  // reset here so per-test handler/leave assertions start clean.
  mockUserChannel.on.mockReset();
  mockUserChannel.leave.mockReset();
});

// Seed a persisted (token, subject) pair the way login()/loginAs() do:
// the subject drives socketUserName(); the token drives the reactive
// join effect.
const seedIdentity = (token: string, name: string) => {
  localStorage.setItem("grappa-token", token);
  localStorage.setItem("grappa-subject", JSON.stringify({ kind: "user", id: "u1", name }));
};

describe("userTopic — user-topic join lifecycle (reactive token)", () => {
  it("joins the user topic once on login and installs the event dispatcher", async () => {
    seedIdentity("tokA", "alice");
    const socket = await import("../lib/socket");
    await import("../lib/userTopic");

    await vi.waitFor(() => {
      expect(socket.joinUser).toHaveBeenCalledWith("alice", expect.any(Function));
    });
    expect(socket.joinUser).toHaveBeenCalledTimes(1);
    expect(mockUserChannel.on).toHaveBeenCalledWith("event", expect.any(Function));
  });

  // #364 cicchetto S1 — the defect. Rotation keeps the identity but
  // rebuilds the socket; userTopic MUST re-join on the fresh socket.
  it("re-joins the user topic on token ROTATION with UNCHANGED identity", async () => {
    seedIdentity("tokA", "alice");
    const auth = await import("../lib/auth");
    const socket = await import("../lib/socket");
    await import("../lib/userTopic");

    await vi.waitFor(() => {
      expect(socket.joinUser).toHaveBeenCalledTimes(1);
    });

    // Fresh bearer, SAME persisted subject → socketUserName() unchanged.
    vi.mocked(socket.joinUser).mockClear();
    auth.setToken("tokB");

    // Must re-join on the rebuilt socket even though the name is unchanged.
    await vi.waitFor(() => {
      expect(socket.joinUser).toHaveBeenCalledWith("alice", expect.any(Function));
    });
    // The prior user-topic Channel is left before re-joining (H2 double-
    // handler-leak parity with subscribe.ts's rotation arm).
    expect(mockUserChannel.leave).toHaveBeenCalled();
  });

  it("leaves the user topic on logout (token → null) and does not re-join", async () => {
    seedIdentity("tokA", "alice");
    const auth = await import("../lib/auth");
    const socket = await import("../lib/socket");
    await import("../lib/userTopic");

    await vi.waitFor(() => {
      expect(socket.joinUser).toHaveBeenCalledTimes(1);
    });

    vi.mocked(socket.joinUser).mockClear();
    auth.setToken(null);

    await vi.waitFor(() => {
      expect(mockUserChannel.leave).toHaveBeenCalled();
    });
    expect(socket.joinUser).not.toHaveBeenCalled();
  });
});
