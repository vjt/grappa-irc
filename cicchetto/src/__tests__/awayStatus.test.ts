import { beforeEach, describe, expect, it, vi } from "vitest";

// Codebase review 2026-05-08 cic H1 (HIGH).
// `awayStatus.ts` registered `on(token, …)` directly inside the
// `createRoot` body — without wrapping in `createEffect(…)`, the
// `on()` combinator just builds an unregistered closure. The
// identity-rotation cleanup never fires; tenant data leaks across
// logout / token rotation.
//
// Sibling stores (`scrollback.ts`, `members.ts`, `selection.ts`,
// `windowState.ts`, `mentions.ts`, `compose.ts`, `readCursor.ts`)
// all use the correct `createEffect(on(token, …))` pattern. The fix
// is to align the two outliers (`awayStatus.ts`, `mentionsWindow.ts`).
//
// Test boundary: vi.mock api so import doesn't hit network. Drive
// rotation via `auth.setToken(...)` like sibling rotation tests
// (selection.test.ts:128).

vi.mock("../lib/api", () => ({
  listNetworks: vi.fn(),
  listChannels: vi.fn(),
  listMessages: vi.fn(),
  sendMessage: vi.fn(),
  me: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  setOn401Handler: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("awayStatus store — identity-rotation cleanup (H1)", () => {
  it("clears awayByNetwork on token rotation (tokA → tokB)", async () => {
    localStorage.setItem("grappa-token", "tokA");
    const auth = await import("../lib/auth");
    const awayStatus = await import("../lib/awayStatus");

    awayStatus.setAwayState("freenode", true);
    expect(awayStatus.awayByNetwork().freenode).toBe(true);

    auth.setToken("tokB");
    await vi.waitFor(() => {
      expect(awayStatus.awayByNetwork().freenode).toBeUndefined();
    });
  });

  it("clears awayByNetwork on logout (token → null)", async () => {
    localStorage.setItem("grappa-token", "tokA");
    const auth = await import("../lib/auth");
    const awayStatus = await import("../lib/awayStatus");

    awayStatus.setAwayState("azzurra", true);
    expect(awayStatus.awayByNetwork().azzurra).toBe(true);

    auth.setToken(null);
    await vi.waitFor(() => {
      expect(awayStatus.awayByNetwork().azzurra).toBeUndefined();
    });
  });
});
