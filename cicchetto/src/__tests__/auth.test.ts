import { beforeEach, describe, expect, it, vi } from "vitest";

// `auth.ts` reads `localStorage` at module load to seed its signal — so
// every test that asserts a different starting state has to (1) seed
// localStorage, (2) reset the module registry, (3) re-import. Without
// `vi.resetModules()` the second test would observe the first test's
// signal value because the module instance is cached across imports.

// #736 — `lib/passkeys` is the browser-ceremony boundary (it calls
// `navigator.credentials`, which jsdom does not implement). Mock it here
// and keep the auth-side branching real: the passkey → TOTP degrade in
// `login()` is the most conditional logic on the auth surface and it
// shipped with no coverage at all.
vi.mock("../lib/passkeys", () => ({
  getPasskey: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  login: vi.fn(),
  verifyTotpLogin: vi.fn(),
  getPasskeyLoginOptions: vi.fn(),
  verifyPasskeyLogin: vi.fn(),
  verifyPasskeySecondFactor: vi.fn(),
  recoverPasskeyLogin: vi.fn(),
  me: vi.fn(),
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

describe("auth signal store", () => {
  it("initializes token from localStorage on module load", async () => {
    localStorage.setItem("grappa-token", "abc");
    const auth = await import("../lib/auth");
    expect(auth.token()).toBe("abc");
    expect(auth.isAuthenticated()).toBe(true);
  });

  it("starts with null token when localStorage is empty", async () => {
    const auth = await import("../lib/auth");
    expect(auth.token()).toBeNull();
    expect(auth.isAuthenticated()).toBe(false);
  });

  it("setToken writes to localStorage and updates the signal", async () => {
    const auth = await import("../lib/auth");
    auth.setToken("xyz");
    expect(localStorage.getItem("grappa-token")).toBe("xyz");
    expect(auth.token()).toBe("xyz");
    expect(auth.isAuthenticated()).toBe(true);
  });

  it("setToken(null) removes from localStorage and clears the signal", async () => {
    localStorage.setItem("grappa-token", "abc");
    const auth = await import("../lib/auth");
    auth.setToken(null);
    expect(localStorage.getItem("grappa-token")).toBeNull();
    expect(auth.token()).toBeNull();
    expect(auth.isAuthenticated()).toBe(false);
  });

  it("login() calls api.login and stores returned token", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.login).mockResolvedValue({
      token: "tok-123",
      subject: { kind: "user", id: "u1", name: "alice" },
    });
    const auth = await import("../lib/auth");
    await auth.login("alice", "secret");
    expect(api.login).toHaveBeenCalledWith({ identifier: "alice", password: "secret" });
    expect(auth.token()).toBe("tok-123");
    expect(localStorage.getItem("grappa-token")).toBe("tok-123");
  });

  it("login() returns a TOTP challenge without authenticating", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.login).mockResolvedValue({
      two_factor_required: true,
      challenge_token: "challenge-123",
    });
    const auth = await import("../lib/auth");
    await expect(auth.login("alice", "secret")).resolves.toEqual({
      kind: "totp",
      challengeToken: "challenge-123",
    });
    expect(auth.token()).toBeNull();
    expect(localStorage.getItem("grappa-token")).toBeNull();
  });

  it("verifyTotp() stores the authenticated session", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.verifyTotpLogin).mockResolvedValue({
      token: "tok-2fa",
      subject: { kind: "user", id: "u1", name: "alice" },
    });
    const auth = await import("../lib/auth");
    await auth.verifyTotp("challenge-123", "123456");
    expect(api.verifyTotpLogin).toHaveBeenCalledWith("challenge-123", "123456");
    expect(auth.token()).toBe("tok-2fa");
  });

  // #736 — a passkey-second-factor login has FOUR outcomes off one server
  // response, and which one you get depends on a browser ceremony that can
  // fail for reasons the server never sees (no authenticator, user dismissed
  // the prompt, timeout). The degrade is silent by design — the whole point
  // is that the user reaches the TOTP form instead of a dead end — which is
  // exactly why it needs pinning: a regression here shows up as "passkey
  // users can't log in", with no error anywhere.
  describe("login() — passkey second factor", () => {
    const passkeyChallenge = (challengeToken: string | null) => ({
      two_factor_required: true as const,
      passkey_options: { challenge_id: "pk-1", public_key: { challenge: "AQID" } },
      totp_available: challengeToken !== null,
      challenge_token: challengeToken,
    });

    it("runs the ceremony and installs the session on a good assertion", async () => {
      const api = await import("../lib/api");
      const { getPasskey } = await import("../lib/passkeys");
      vi.mocked(api.login).mockResolvedValue(passkeyChallenge("challenge-123"));
      vi.mocked(getPasskey).mockResolvedValue({ raw_id: "AQ" });
      vi.mocked(api.verifyPasskeySecondFactor).mockResolvedValue({
        token: "tok-passkey",
        subject: { kind: "user", id: "u1", name: "alice" },
      });
      const auth = await import("../lib/auth");

      await expect(auth.login("alice", "secret")).resolves.toEqual({ kind: "authenticated" });

      expect(getPasskey).toHaveBeenCalledWith({
        challenge_id: "pk-1",
        public_key: { challenge: "AQID" },
      });
      expect(api.verifyPasskeySecondFactor).toHaveBeenCalledWith({ raw_id: "AQ" });
      expect(auth.token()).toBe("tok-passkey");
    });

    it("degrades to the TOTP challenge when the ceremony fails and a code is available", async () => {
      const api = await import("../lib/api");
      const { getPasskey } = await import("../lib/passkeys");
      vi.mocked(api.login).mockResolvedValue(passkeyChallenge("challenge-123"));
      vi.mocked(getPasskey).mockRejectedValue(new Error("Passkey authentication cancelled"));
      const auth = await import("../lib/auth");

      await expect(auth.login("alice", "secret")).resolves.toEqual({
        kind: "totp",
        challengeToken: "challenge-123",
      });

      expect(api.verifyPasskeySecondFactor).not.toHaveBeenCalled();
      expect(auth.token()).toBeNull();
    });

    it("degrades to the TOTP challenge when the server rejects the assertion", async () => {
      // A rejected assertion (replayed challenge, expired ceremony) is a
      // ceremony failure like any other: the account still has a second
      // factor the user can reach, so the form must offer it.
      const api = await import("../lib/api");
      const { getPasskey } = await import("../lib/passkeys");
      vi.mocked(api.login).mockResolvedValue(passkeyChallenge("challenge-123"));
      vi.mocked(getPasskey).mockResolvedValue({ raw_id: "AQ" });
      vi.mocked(api.verifyPasskeySecondFactor).mockRejectedValue(new Error("challenge_expired"));
      const auth = await import("../lib/auth");

      await expect(auth.login("alice", "secret")).resolves.toEqual({
        kind: "totp",
        challengeToken: "challenge-123",
      });
      expect(auth.token()).toBeNull();
    });

    it("rethrows the ceremony error when the account has no TOTP fallback", async () => {
      // `challenge_token: null` means the server minted no TOTP challenge —
      // passkey is the ONLY second factor. Swallowing the error here would
      // resolve the login as authenticated with no token.
      const api = await import("../lib/api");
      const { getPasskey } = await import("../lib/passkeys");
      vi.mocked(api.login).mockResolvedValue(passkeyChallenge(null));
      vi.mocked(getPasskey).mockRejectedValue(new Error("Passkey authentication cancelled"));
      const auth = await import("../lib/auth");

      await expect(auth.login("alice", "secret")).rejects.toThrow(
        "Passkey authentication cancelled",
      );
      expect(auth.token()).toBeNull();
      expect(localStorage.getItem("grappa-token")).toBeNull();
    });
  });

  describe("passkey login entry points", () => {
    it("loginWithPasskey() fetches options, signs them, and installs the session", async () => {
      const api = await import("../lib/api");
      const { getPasskey } = await import("../lib/passkeys");
      const options = { challenge_id: "pk-1", public_key: { challenge: "AQID" } };
      vi.mocked(api.getPasskeyLoginOptions).mockResolvedValue(options);
      vi.mocked(getPasskey).mockResolvedValue({ raw_id: "AQ" });
      vi.mocked(api.verifyPasskeyLogin).mockResolvedValue({
        token: "tok-passwordless",
        subject: { kind: "user", id: "u1", name: "alice" },
      });
      const auth = await import("../lib/auth");

      await auth.loginWithPasskey("alice");

      expect(api.getPasskeyLoginOptions).toHaveBeenCalledWith("alice");
      expect(getPasskey).toHaveBeenCalledWith(options);
      expect(api.verifyPasskeyLogin).toHaveBeenCalledWith({ raw_id: "AQ" });
      expect(auth.token()).toBe("tok-passwordless");
      expect(localStorage.getItem("grappa-subject")).toBe(
        JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
      );
    });

    it("loginWithPasskey() leaves no token behind when the ceremony is cancelled", async () => {
      const api = await import("../lib/api");
      const { getPasskey } = await import("../lib/passkeys");
      vi.mocked(api.getPasskeyLoginOptions).mockResolvedValue({
        challenge_id: "pk-1",
        public_key: {},
      });
      vi.mocked(getPasskey).mockRejectedValue(new Error("Passkey authentication cancelled"));
      const auth = await import("../lib/auth");

      await expect(auth.loginWithPasskey("alice")).rejects.toThrow(
        "Passkey authentication cancelled",
      );

      expect(api.verifyPasskeyLogin).not.toHaveBeenCalled();
      expect(auth.token()).toBeNull();
    });

    it("loginWithRecoveryCode() installs the session for a good code", async () => {
      const api = await import("../lib/api");
      vi.mocked(api.recoverPasskeyLogin).mockResolvedValue({
        token: "tok-recovered",
        subject: { kind: "user", id: "u1", name: "alice" },
      });
      const auth = await import("../lib/auth");

      await auth.loginWithRecoveryCode("alice", "code-1234");

      expect(api.recoverPasskeyLogin).toHaveBeenCalledWith("alice", "code-1234");
      expect(auth.token()).toBe("tok-recovered");
    });
  });

  it("logout() calls api.logout with current token and clears state", async () => {
    localStorage.setItem("grappa-token", "tok-abc");
    const api = await import("../lib/api");
    vi.mocked(api.logout).mockResolvedValue(undefined);
    const auth = await import("../lib/auth");
    await auth.logout();
    expect(api.logout).toHaveBeenCalledWith("tok-abc");
    expect(auth.token()).toBeNull();
    expect(localStorage.getItem("grappa-token")).toBeNull();
  });

  // C3 — localStorage is mutated by the user (devtools), browser
  // extensions, and any successful XSS. `getSubject()` MUST narrow on
  // `unknown` and reject malformed payloads, otherwise a tampered
  // {"kind":"user"} (missing id/name) types as Subject and downstream
  // consumers reading `subject.name` get `undefined` typed as `string`.
  describe("getSubject() validation", () => {
    it("returns null when no key present", async () => {
      const auth = await import("../lib/auth");
      expect(auth.getSubject()).toBeNull();
    });

    it("returns valid user subject", async () => {
      localStorage.setItem(
        "grappa-subject",
        JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
      );
      const auth = await import("../lib/auth");
      const s = auth.getSubject();
      expect(s).toEqual({ kind: "user", id: "u1", name: "alice" });
    });

    it("returns valid visitor subject", async () => {
      localStorage.setItem(
        "grappa-subject",
        JSON.stringify({
          kind: "visitor",
          id: "v1",
          nick: "vjt",
        }),
      );
      const auth = await import("../lib/auth");
      const s = auth.getSubject();
      expect(s).toEqual({
        kind: "visitor",
        id: "v1",
        nick: "vjt",
      });
    });

    // #211 phase 6 — a visitor subject persisted WITHOUT network_slug
    // (post-drop, or a pre-drop subject after the field vanished) MUST
    // still validate. Guarding it would logout-loop every returning
    // visitor. The scalar is gone from the subject contract entirely.
    it("returns valid visitor subject even with a stray network_slug (ignored)", async () => {
      localStorage.setItem(
        "grappa-subject",
        JSON.stringify({ kind: "visitor", id: "v1", nick: "vjt", network_slug: "azzurra" }),
      );
      const auth = await import("../lib/auth");
      const s = auth.getSubject();
      // isValidSubject narrows on {id, nick} only — a stray legacy field
      // rides through untouched (JSON.parse keeps it) but validation
      // ignores it.
      expect(s?.kind).toBe("visitor");
      expect(s?.id).toBe("v1");
    });

    it("returns null + clears key on tampered user (missing fields)", async () => {
      localStorage.setItem("grappa-subject", JSON.stringify({ kind: "user" }));
      const auth = await import("../lib/auth");
      expect(auth.getSubject()).toBeNull();
      expect(localStorage.getItem("grappa-subject")).toBeNull();
    });

    it("returns null + clears key on tampered visitor (missing id)", async () => {
      // #211 phase 7 — `nick` is DROPPED from the visitor subject, so the
      // only required field is `id`. A subject with a missing/non-string
      // id is the tamper case now.
      localStorage.setItem("grappa-subject", JSON.stringify({ kind: "visitor" }));
      const auth = await import("../lib/auth");
      expect(auth.getSubject()).toBeNull();
      expect(localStorage.getItem("grappa-subject")).toBeNull();
    });

    it("returns valid visitor subject with no nick (#211 phase 7 — nick dropped)", async () => {
      localStorage.setItem("grappa-subject", JSON.stringify({ kind: "visitor", id: "v1" }));
      const auth = await import("../lib/auth");
      const s = auth.getSubject();
      expect(s?.kind).toBe("visitor");
      expect(s?.id).toBe("v1");
    });

    it("returns null + clears key on unknown kind", async () => {
      localStorage.setItem("grappa-subject", JSON.stringify({ kind: "robot", id: "r1" }));
      const auth = await import("../lib/auth");
      expect(auth.getSubject()).toBeNull();
      expect(localStorage.getItem("grappa-subject")).toBeNull();
    });

    it("returns null + clears key on non-JSON gibberish", async () => {
      localStorage.setItem("grappa-subject", "not-json{{");
      const auth = await import("../lib/auth");
      expect(auth.getSubject()).toBeNull();
      expect(localStorage.getItem("grappa-subject")).toBeNull();
    });

    it("returns null + clears key on non-object payload (string)", async () => {
      localStorage.setItem("grappa-subject", JSON.stringify("hello"));
      const auth = await import("../lib/auth");
      expect(auth.getSubject()).toBeNull();
      expect(localStorage.getItem("grappa-subject")).toBeNull();
    });
  });

  // M-cic-6 — `setOn401Handler` used to fire as a module-load side
  // effect of `auth.ts`. Any test that imported `auth.ts` (directly or
  // transitively, e.g. via `Login.tsx`) wired the global api module's
  // 401 handler before Vitest's mock-reset window opened, leaking
  // state across files. Move to an explicit `bootstrapAuth()` called
  // once from `main.tsx`; importing the module no longer mutates
  // the api module.
  describe("bootstrapAuth() — explicit 401 handler wiring", () => {
    it("does NOT register a 401 handler at module load", async () => {
      let registrations = 0;
      vi.doMock("../lib/api", () => ({
        login: vi.fn(),
        me: vi.fn(),
        logout: vi.fn(),
        setOn401Handler: vi.fn().mockImplementation(() => {
          registrations++;
        }),
      }));
      await import("../lib/auth");
      expect(registrations).toBe(0);
      vi.doUnmock("../lib/api");
    });

    it("registers a 401 handler that clears the token when bootstrapAuth is called", async () => {
      let captured: (() => void) | null = null;
      vi.doMock("../lib/api", () => ({
        login: vi.fn(),
        me: vi.fn(),
        logout: vi.fn(),
        setOn401Handler: vi.fn().mockImplementation((fn: () => void) => {
          captured = fn;
        }),
      }));
      localStorage.setItem("grappa-token", "tok-stale");
      const auth = await import("../lib/auth");
      expect(auth.token()).toBe("tok-stale");
      // Pre-bootstrap: no handler captured yet.
      expect(captured).toBeNull();
      auth.bootstrapAuth();
      expect(captured).not.toBeNull();
      if (captured !== null) (captured as () => void)();
      expect(auth.token()).toBeNull();
      expect(localStorage.getItem("grappa-token")).toBeNull();
      vi.doUnmock("../lib/api");
    });
  });
});
