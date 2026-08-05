import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setToken } from "../lib/auth";
import { channelKey } from "../lib/channelKey";
import { getColoredNicklist, setColoredNicklist } from "../lib/colorNicklist";
import {
  applyServerPrefs,
  buildWireMap,
  mountDisplayPrefsSync,
  syncedSetChannelPresencePref,
  syncedSetColoredNicklist,
  syncedSetTimeFormat,
} from "../lib/displayPrefs";
import {
  getAllPresencePrefs,
  getChannelPresencePref,
  replacePresencePrefs,
} from "../lib/presenceFilter";
import { loadInitialScrollback, purgeScrollback } from "../lib/scrollback";
import { getTimeFormat, setTimeFormat } from "../lib/timeFormat";
import type { DisplayPrefs } from "../lib/userSettings";

// #458 — refetch-on-reveal. Option 1 filters presence rows out of the REST page
// server-side when the channel's pref hides them, so `limit` counts VISIBLE rows.
// The consequence: toggling a channel back to "show" needs rows the server never
// sent. `syncedSetChannelPresencePref` therefore purges + cold-reloads the
// channel on "show" (rows are missing) and does NOTHING extra on "hide" (the
// render filter drops rows already in the store — no wasted fetch). Mock the
// scrollback seams so the coordinator's decision is observable without a store.
vi.mock("../lib/scrollback", async (importActual) => {
  const actual = await importActual<typeof import("../lib/scrollback")>();
  return { ...actual, purgeScrollback: vi.fn(), loadInitialScrollback: vi.fn() };
});

// #449 — server-backed display prefs coordinator. The three localStorage-only
// prefs (presence filter #222, time format #217, colored nicklist #443) never
// converged across one account's devices; this coordinator mirrors the theme
// sync (boot-cached apply + login reconcile) so they do. Seed-up-once (Fork B):
// a server that never persisted gets the local values PUSHED up (never wiped);
// otherwise the server wins. `persisted` is the discriminator.

const TOKEN = "test-bearer";
const KEY_A = channelKey("n", "#a");
const KEY_B = channelKey("n", "#b");

// Reset the three module singletons to defaults + drop the token so every test
// starts from a known local baseline (the signals persist across the suite).
function resetLocal(): void {
  localStorage.clear();
  setTimeFormat("hms");
  setColoredNicklist(false);
  replacePresencePrefs({});
  setToken(null);
}

// Flush Solid's effect queue + any chained microtasks (GET → then → PUT).
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// A fetch stub that answers GET vs PUT distinctly and mints a FRESH Response
// per call (a Response body can only be read once — a shared instance would
// throw "body already read" on the second call).
function stubFetch(getBody: unknown, putBody: unknown): void {
  vi.spyOn(globalThis, "fetch").mockImplementation((_url, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = method === "GET" ? getBody : putBody;
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  });
}

beforeEach(() => {
  // Reset call history on the module-level scrollback mocks (vi.mock factory
  // fns persist across the suite, so SHOW's purge/reload calls would otherwise
  // bleed into the HIDE test's "not called" assertion). Clears history only —
  // implementations survive.
  vi.clearAllMocks();
  resetLocal();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetLocal();
});

describe("buildWireMap", () => {
  it("reads the three module getters into the wire shape", () => {
    setTimeFormat("hm");
    setColoredNicklist(true);
    replacePresencePrefs({ [KEY_A]: "hide" });

    expect(buildWireMap()).toEqual({
      time_format: "hm",
      colored_nicklist: true,
      presence_filter: { [KEY_A]: "hide" },
    });
  });

  it("emits an empty presence_filter when no channel is pinned", () => {
    expect(buildWireMap().presence_filter).toEqual({});
  });
});

describe("applyServerPrefs", () => {
  it("distributes server prefs into the three local setters", () => {
    applyServerPrefs({
      time_format: "hm",
      colored_nicklist: true,
      presence_filter: { [KEY_A]: "hide" },
    });

    expect(getTimeFormat()).toBe("hm");
    expect(getColoredNicklist()).toBe(true);
    expect(getChannelPresencePref(KEY_A)).toBe("hide");
  });

  it("tri-state: an unset channel stays ABSENT after apply (never coerced)", () => {
    // Server carries only #a. #b must not appear in the local map.
    applyServerPrefs({
      time_format: "hms",
      colored_nicklist: false,
      presence_filter: { [KEY_A]: "hide" },
    });

    const map = getAllPresencePrefs();
    expect(map[KEY_A]).toBe("hide");
    expect(KEY_B in map).toBe(false);
  });

  it("replaces the whole presence map (a full-map apply clears stale pins)", () => {
    replacePresencePrefs({ [KEY_A]: "hide", [KEY_B]: "show" });
    applyServerPrefs({
      time_format: "hms",
      colored_nicklist: false,
      presence_filter: { [KEY_A]: "show" },
    });

    expect(getAllPresencePrefs()).toEqual({ [KEY_A]: "show" });
  });
});

describe("mountDisplayPrefsSync — login reconcile", () => {
  it("server wins when the server has persisted prefs", async () => {
    const server: DisplayPrefs = {
      time_format: "hm",
      colored_nicklist: true,
      presence_filter: { [KEY_A]: "hide" },
    };
    stubFetch(
      { display_prefs: server, persisted: true },
      { display_prefs: server, persisted: true },
    );

    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      mountDisplayPrefsSync();
    });
    setToken(TOKEN);
    await flush();

    expect(getTimeFormat()).toBe("hm");
    expect(getColoredNicklist()).toBe(true);
    expect(getChannelPresencePref(KEY_A)).toBe("hide");
    dispose();
  });

  it("seeds up the local values when the server has NEVER persisted", async () => {
    // Local state the operator built on this device — must survive + push up.
    setTimeFormat("hm");
    setColoredNicklist(true);
    replacePresencePrefs({ [KEY_A]: "hide" });

    const serverDefaults: DisplayPrefs = {
      time_format: "hms",
      colored_nicklist: false,
      presence_filter: {},
    };
    stubFetch(
      { display_prefs: serverDefaults, persisted: false },
      { display_prefs: serverDefaults, persisted: true },
    );

    // Real logged-in-boot order: the auth signal already holds the token before
    // the effect first runs, so the logout-clear branch never fires and the
    // boot-seeded local values are what seed up.
    setToken(TOKEN);
    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      mountDisplayPrefsSync();
    });
    await flush();

    // A seed-up PUT fired carrying the LOCAL values (never the server default).
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const putCall = fetchMock.mock.calls.find(
      (c) => ((c[1] as RequestInit | undefined)?.method ?? "GET").toUpperCase() === "PUT",
    );
    expect(putCall).toBeDefined();
    const putInit = putCall?.[1] as RequestInit;
    expect(JSON.parse(putInit.body as string)).toEqual({
      display_prefs: {
        time_format: "hm",
        colored_nicklist: true,
        presence_filter: { [KEY_A]: "hide" },
      },
    });

    // Local values are untouched by the seed-up (no clobber to server default).
    expect(getTimeFormat()).toBe("hm");
    expect(getColoredNicklist()).toBe(true);
    dispose();
  });

  it("keeps the boot cache on an offline GET failure (never throws)", async () => {
    setTimeFormat("hm");
    replacePresencePrefs({ [KEY_A]: "hide" });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    // Real logged-in-boot order: token present before the effect first runs, so
    // the failed GET falls through to the keep-boot-cache catch (not the clear).
    setToken(TOKEN);
    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      mountDisplayPrefsSync();
    });
    await flush();

    // Boot-cached local values survive the failed refresh.
    expect(getTimeFormat()).toBe("hm");
    expect(getChannelPresencePref(KEY_A)).toBe("hide");
    dispose();
  });

  it("mounted logged-out: no fetch, and the cache is cleared to defaults", async () => {
    setTimeFormat("hm");
    const fetchMock = vi.spyOn(globalThis, "fetch");

    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      mountDisplayPrefsSync();
    });
    // token is already null (resetLocal) — the logged-out branch: no server
    // round-trip, and the cache resets to defaults (no residual to seed up).
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(getTimeFormat()).toBe("hms");
    dispose();
  });
});

describe("syncedSet* — optimistic local + full-map PUT", () => {
  it("syncedSetTimeFormat sets local and PUTs the full wire map when logged in", async () => {
    setColoredNicklist(true);
    replacePresencePrefs({ [KEY_A]: "hide" });
    setToken(TOKEN);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ display_prefs: buildWireMap(), persisted: true }), {
        status: 200,
      }),
    );

    syncedSetTimeFormat("hm");
    await flush();

    expect(getTimeFormat()).toBe("hm"); // optimistic local applied
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/me/settings/display-prefs");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      display_prefs: {
        time_format: "hm",
        colored_nicklist: true,
        presence_filter: { [KEY_A]: "hide" },
      },
    });
  });

  it("syncedSetColoredNicklist + syncedSetChannelPresencePref set local without a PUT when logged out", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    syncedSetColoredNicklist(true);
    syncedSetChannelPresencePref(KEY_A, "hide");
    await flush();

    expect(getColoredNicklist()).toBe(true);
    expect(getChannelPresencePref(KEY_A)).toBe("hide");
    expect(fetchMock).not.toHaveBeenCalled(); // no token → local-only
  });
});

// S1 (review) — clear-on-logout so a shared browser / visitor→user upgrade can
// NOT bleed subject A's residual local prefs into subject B's server account.
// Keep-cache-on-logout was safe while the cache was read-only display state; the
// seed-up made it a WRITE source, so a never-persisted next login would PUT the
// prior subject's residual values. Parity with mountCustomThemeSync's clear.
describe("mountDisplayPrefsSync — clear-on-logout (no cross-account bleed)", () => {
  const DEFAULTS = { time_format: "hms", colored_nicklist: false, presence_filter: {} };

  // Phase-mutable fetch stub: the GET body changes across A-login / B-login.
  let getBody: unknown;
  function installPhaseFetch(): ReturnType<typeof vi.fn> {
    return vi.spyOn(globalThis, "fetch").mockImplementation((_url, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      // The PUT body is echoed back persisted:true; the coordinator ignores it.
      const body = method === "GET" ? getBody : { display_prefs: DEFAULTS, persisted: true };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }) as unknown as ReturnType<typeof vi.fn>;
  }

  it("resets local prefs to defaults on logout", async () => {
    const aPrefs = {
      time_format: "hm",
      colored_nicklist: true,
      presence_filter: { [KEY_A]: "hide" },
    };
    getBody = { display_prefs: aPrefs, persisted: true };
    installPhaseFetch();

    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      mountDisplayPrefsSync();
    });

    setToken(TOKEN); // A logs in — server wins, A's prefs applied locally
    await flush();
    expect(getTimeFormat()).toBe("hm");

    setToken(null); // A logs out
    await flush();

    expect(getTimeFormat()).toBe("hms");
    expect(getColoredNicklist()).toBe(false);
    expect(getAllPresencePrefs()).toEqual({});
    dispose();
  });

  it("does NOT seed a prior subject's prefs into a never-persisted next login", async () => {
    const aPrefs = {
      time_format: "hm",
      colored_nicklist: true,
      presence_filter: { [KEY_A]: "hide" },
    };
    getBody = { display_prefs: aPrefs, persisted: true };
    const fetchMock = installPhaseFetch();

    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      mountDisplayPrefsSync();
    });

    setToken(TOKEN); // A logs in
    await flush();
    setToken(null); // A logs out — cache MUST clear
    await flush();

    // B is a never-persisted subject: GET → persisted:false → seed-up.
    getBody = { display_prefs: DEFAULTS, persisted: false };
    fetchMock.mockClear();
    setToken("B-bearer");
    await flush();

    const putCall = fetchMock.mock.calls.find(
      (c) => ((c[1] as RequestInit | undefined)?.method ?? "GET").toUpperCase() === "PUT",
    );
    expect(putCall).toBeDefined();
    // The seed-up carries DEFAULTS, never A's residual "hm"/true/{#a:hide}.
    expect(JSON.parse((putCall![1] as RequestInit).body as string)).toEqual({
      display_prefs: DEFAULTS,
    });
    dispose();
  });
});

// #449 (issue222 regression) — an optimistic syncedSet* whose PUT never ACKed
// (e.g. a reload raced/aborted the fire-and-forget PUT) must NOT be clobbered by
// the next reconcile. Pre-fix, `applyServerPrefs` did a FULL replace that
// rewrote the signal AND the localStorage boot cache, so a stale server GET
// (missing the just-set channel) WIPED the pref for good — the e2e caught the
// join/part rows reappearing after reload. The fix: a durable "unsynced" flag
// makes the reconcile PUSH the local state up (seed-up path) while a write is
// unconfirmed, rather than letting the server value win.
describe("mountDisplayPrefsSync — an unconfirmed local write survives a reload (issue222)", () => {
  it("reconcile re-pushes the local pref (never clobbers) when the toggle PUT never ACKed", async () => {
    setToken(TOKEN);
    // 1. User toggles #a → hide, but the fire-and-forget PUT REJECTS (a reload
    //    aborted it / offline). The write stays UNCONFIRMED.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("PUT aborted by reload"));
    syncedSetChannelPresencePref(KEY_A, "hide");
    await flush();
    expect(getChannelPresencePref(KEY_A)).toBe("hide"); // optimistic local applied

    // 2. Reload: a fresh reconcile. GET returns persisted:true but WITHOUT #a
    //    (the toggle PUT never landed → stale server). Capture the PUT bodies.
    vi.restoreAllMocks();
    const staleServer: DisplayPrefs = {
      time_format: "hms",
      colored_nicklist: false,
      presence_filter: {},
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((_u, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const body =
        method === "GET"
          ? { display_prefs: staleServer, persisted: true }
          : { display_prefs: buildWireMap(), persisted: true };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    });

    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      mountDisplayPrefsSync();
    });
    await flush();

    // The pin is PRESERVED (the full-replace did NOT wipe it) ...
    expect(getChannelPresencePref(KEY_A)).toBe("hide");
    // ... and the reconcile RE-PUSHED the local state (seed-up), carrying #a.
    const putCall = fetchMock.mock.calls.find(
      (c) => ((c[1] as RequestInit | undefined)?.method ?? "GET").toUpperCase() === "PUT",
    );
    expect(putCall).toBeDefined();
    expect(
      JSON.parse((putCall![1] as RequestInit).body as string).display_prefs.presence_filter,
    ).toEqual({ [KEY_A]: "hide" });
    dispose();
  });

  it("after a CONFIRMED synced write, a later reconcile lets the server win (no permanent local pin)", async () => {
    setToken(TOKEN);
    // Toggle #a → hide with the PUT RESOLVING → the unsynced flag is cleared.
    stubFetch(
      { display_prefs: buildWireMap(), persisted: true },
      { display_prefs: buildWireMap(), persisted: true },
    );
    syncedSetChannelPresencePref(KEY_A, "hide");
    await flush();

    // Reload: the server is now authoritative WITHOUT #a (another device unpinned
    // it). Because the earlier write was CONFIRMED, server-wins must resume so the
    // cross-device unpin propagates — the pin must NOT be re-pushed forever.
    vi.restoreAllMocks();
    const server: DisplayPrefs = {
      time_format: "hms",
      colored_nicklist: false,
      presence_filter: {},
    };
    stubFetch(
      { display_prefs: server, persisted: true },
      { display_prefs: server, persisted: true },
    );

    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      mountDisplayPrefsSync();
    });
    await flush();

    expect(getChannelPresencePref(KEY_A)).toBeUndefined(); // server won: #a dropped
    dispose();
  });
});

// #458 — Option 1's accepted consequence: revealing presence needs rows the
// server filtered out. The coordinator is the SSOT for the synced write, so the
// refetch hook lives HERE (not in the UI toggle) — one code path for every door.
describe("syncedSetChannelPresencePref — refetch on reveal (#458)", () => {
  const asMock = (fn: unknown): ReturnType<typeof vi.fn> =>
    fn as unknown as ReturnType<typeof vi.fn>;

  it("SHOW refetches only AFTER the persist PUT resolves, then purges before reloading", async () => {
    setToken(TOKEN);
    // A PUT that stays pending until we resolve it, so we can observe whether the
    // refetch fires BEFORE the pref is persisted. The server resolves
    // hide_presence from the PERSISTED pref, so a refetch that races the PUT can
    // read a still-"hide" pref and return content-only rows — nothing to reveal.
    let resolvePut!: (r: Response) => void;
    const putGate = new Promise<Response>((r) => {
      resolvePut = r;
    });
    vi.spyOn(globalThis, "fetch").mockReturnValue(putGate);

    syncedSetChannelPresencePref(KEY_A, "show");
    await flush();

    // PUT still in flight → the refetch MUST NOT have fired yet (read-your-write
    // not yet guaranteed). This is the #458 race the fix closes.
    expect(asMock(purgeScrollback)).not.toHaveBeenCalled();
    expect(asMock(loadInitialScrollback)).not.toHaveBeenCalled();

    // Persist lands → read-your-write is now safe → the refetch fires.
    resolvePut(
      new Response(JSON.stringify({ display_prefs: buildWireMap(), persisted: true }), {
        status: 200,
      }),
    );
    await flush();

    // Purge clears the filtered rows + the load-once gate; the cold-reload then
    // re-fetches with presence NOW visible (the server re-includes them).
    expect(asMock(purgeScrollback)).toHaveBeenCalledWith(KEY_A);
    expect(asMock(loadInitialScrollback)).toHaveBeenCalledWith("n", "#a");
    // Order is load-bearing: loadInitialScrollback's load-once gate SKIPS a key
    // still in `loadedChannels`, so the purge (which drops the key) MUST run
    // first — else the reload no-ops and the revealed rows never arrive.
    const purgeOrder = asMock(purgeScrollback).mock.invocationCallOrder[0];
    const loadOrder = asMock(loadInitialScrollback).mock.invocationCallOrder[0];
    expect(purgeOrder).toBeDefined();
    expect(loadOrder).toBeDefined();
    if (purgeOrder !== undefined && loadOrder !== undefined) {
      expect(purgeOrder).toBeLessThan(loadOrder);
    }
  });

  it("HIDE does not refetch (the render filter drops rows already in the store)", async () => {
    syncedSetChannelPresencePref(KEY_A, "hide");
    await flush();

    expect(asMock(purgeScrollback)).not.toHaveBeenCalled();
    expect(asMock(loadInitialScrollback)).not.toHaveBeenCalled();
  });
});

// #837 — the mid-flight identity guard, the OTHER door into the cross-account
// bleed the clear-on-logout block above closes. That block covers the identity
// TRANSITION (logout clears, so B never inherits A's residue). This one covers
// what the transition cannot reach: a GET already in flight when the rotation
// happens. The effect captured A's token at entry and nothing cancels its
// request, so the continuation resumes holding a bearer the server has already
// retired — and it acts on the response.
//
// Two distinct harms, one per case below:
//   * server-wins applies A's prefs over B's freshly-loaded ones;
//   * a never-persisted A response fires a seed-up PUT under A's retired
//     bearer — a 401/404 on the host's fail2ban-watched surface (#281's class).
//
// The rotation must land strictly INSIDE the await: A's GET is held open until
// setToken has already re-run the effect for B and B's own answer has applied.
describe("mountDisplayPrefsSync — a response that outlives its identity (#837)", () => {
  const OTHER = "B-bearer";

  const A_PREFS: DisplayPrefs = {
    time_format: "hm",
    colored_nicklist: true,
    presence_filter: { [KEY_A]: "hide" },
  };
  // Distinct from A on all three axes, so "B's state survived" is an assertion
  // about B's values rather than about the module defaults.
  const B_PREFS: DisplayPrefs = {
    time_format: "hms",
    colored_nicklist: false,
    presence_filter: { [KEY_B]: "hide" },
  };

  const bearerOf = (init?: RequestInit): string | null =>
    new Headers(init?.headers).get("authorization");

  const methodOf = (init?: RequestInit): string => (init?.method ?? "GET").toUpperCase();

  const jsonResponse = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200 });

  // Hold A's GET open; answer everything else immediately. B's GET carries
  // B_PREFS persisted, so the only route by which A's values can reach the
  // local state is the held continuation under test.
  function stubWithHeldGetForA(): { release: (body: unknown) => void } {
    let release!: (r: Response) => void;
    const held = new Promise<Response>((r) => {
      release = r;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init?: RequestInit) => {
      if (methodOf(init) === "GET" && bearerOf(init) === `Bearer ${TOKEN}`) return held;
      return Promise.resolve(jsonResponse({ display_prefs: B_PREFS, persisted: true }));
    });
    return { release: (body: unknown) => release(jsonResponse(body)) };
  }

  const putBearers = (): (string | null)[] =>
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter((c) => methodOf(c[1] as RequestInit | undefined) === "PUT")
      .map((c) => bearerOf(c[1] as RequestInit | undefined));

  // Disposal in afterEach, not at the end of each case: the effect under test
  // writes module-singleton state, so a case that fails an assertion and skips
  // its own dispose() would leave a live sync running against the NEXT case's
  // fetch stub — the failure would then cascade into a neighbour that is fine.
  let dispose: (() => void) | null = null;

  function mountFor(t: string): void {
    setToken(t);
    createRoot((d) => {
      dispose = d;
      mountDisplayPrefsSync();
    });
  }

  afterEach(() => {
    dispose?.();
    dispose = null;
  });

  // Drive A-login → mount → rotate to B → release A's held GET with `body`.
  async function rotateUnderAHeldGet(body: unknown): Promise<void> {
    const a = stubWithHeldGetForA();
    mountFor(TOKEN);
    await flush(); // A's GET is on the wire, held
    setToken(OTHER); // rotation lands INSIDE A's await; B's own GET answers
    await flush();
    a.release(body);
    await flush();
  }

  it("does not apply the previous subject's prefs when its GET lands after a rotation", async () => {
    await rotateUnderAHeldGet({ display_prefs: A_PREFS, persisted: true });

    expect(getTimeFormat()).toBe(B_PREFS.time_format);
    expect(getColoredNicklist()).toBe(B_PREFS.colored_nicklist);
    expect(getAllPresencePrefs()).toEqual(B_PREFS.presence_filter);
  });

  // The control for the case above. Same harness, same held GET, no rotation:
  // if A's response stopped reaching the apply path at all (a broken gate, a
  // changed wire shape), the case above would pass while testing nothing.
  it("does apply that same response when the identity holds", async () => {
    const a = stubWithHeldGetForA();
    mountFor(TOKEN);
    await flush();
    a.release({ display_prefs: A_PREFS, persisted: true });
    await flush();

    expect(getTimeFormat()).toBe(A_PREFS.time_format);
    expect(getColoredNicklist()).toBe(A_PREFS.colored_nicklist);
    expect(getAllPresencePrefs()).toEqual(A_PREFS.presence_filter);
  });

  it("does not seed up under a bearer the rotation already retired", async () => {
    // persisted:false is the seed-up branch — the one that PUTs. Under A's
    // retired bearer that write is both a wrong-identity request and, if the
    // server honoured it, A's local map landing on B's account.
    await rotateUnderAHeldGet({ display_prefs: A_PREFS, persisted: false });

    expect(putBearers()).not.toContain(`Bearer ${TOKEN}`);
  });
});
