import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MentionsBundle } from "../MentionsWindow";

// Codebase review 2026-05-08 cic H1 (HIGH) — companion to
// `awayStatus.test.ts`. Same root cause: `on(token, …)` registered
// without wrapping in `createEffect(…)`. The mentions-bundle store
// retains the prior tenant's "you missed these mentions while away"
// snapshot across logout / rotation.

vi.mock("../lib/api", () => ({
  listNetworks: vi.fn(),
  listChannels: vi.fn(),
  listMessages: vi.fn(),
  sendMessage: vi.fn(),
  me: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  setOn401Handler: vi.fn(),
  // 2026-06-01 (unread-badges-from-cursor cluster, bucket B2):
  // selection.ts now imports isContentKind from api.ts for the badge
  // memo derivation. Any test importing selection (directly or
  // transitively) needs the classifier in its api mock.
  isContentKind: (k: string) => k === "privmsg" || k === "notice" || k === "action",
  isPresenceKind: (k: string) => !(k === "privmsg" || k === "notice" || k === "action"),
}));

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.clearAllMocks();
});

const fixture = (slug: string): MentionsBundle => ({
  network_slug: slug,
  away_started_at: "2026-05-08T10:00:00Z",
  away_ended_at: "2026-05-08T11:00:00Z",
  away_reason: null,
  messages: [
    {
      server_time: 1,
      channel: "#chan",
      sender: "alice",
      body: "hey",
      kind: "privmsg",
    },
  ],
});

describe("mentionsWindow store — identity-rotation cleanup (H1)", () => {
  it("clears mentionsBundleBySlug on token rotation (tokA → tokB)", async () => {
    localStorage.setItem("grappa-token", "tokA");
    const auth = await import("../lib/auth");
    const mw = await import("../lib/mentionsWindow");

    mw.setMentionsBundle("freenode", fixture("freenode"));
    expect(mw.mentionsBundleBySlug().freenode).toBeDefined();

    auth.setToken("tokB");
    await vi.waitFor(() => {
      expect(mw.mentionsBundleBySlug().freenode).toBeUndefined();
    });
  });

  it("clears mentionsBundleBySlug on logout (token → null)", async () => {
    localStorage.setItem("grappa-token", "tokA");
    const auth = await import("../lib/auth");
    const mw = await import("../lib/mentionsWindow");

    mw.setMentionsBundle("azzurra", fixture("azzurra"));
    expect(mw.mentionsBundleBySlug().azzurra).toBeDefined();

    auth.setToken(null);
    await vi.waitFor(() => {
      expect(mw.mentionsBundleBySlug().azzurra).toBeUndefined();
    });
  });
});
