import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearVapidPublicKeyCache,
  deletePushSubscription,
  deviceRows,
  disablePush,
  ensurePushSubscription,
  formatDeviceActivity,
  getVapidPublicKey,
  listPushDevices,
  type PushDeviceSummary,
  postPushSubscription,
  pushAvailable,
  type SubscriptionId,
  subscriptionIdForEndpoint,
  vapidKeyToUint8Array,
} from "../lib/push";

// Push notifications cluster B2 (2026-05-14) — push.ts helpers.
//
// Coverage: VAPID-key fetch + localStorage cache + base64url ↔
// Uint8Array conversion (the bridge between server-emitted
// `Base.url_encode64(_, padding: false)` and `pushManager.subscribe`'s
// `applicationServerKey: BufferSource` requirement) + the three
// REST helpers (POST, DELETE, GET) that B3 settings UI consumes.
//
// fetch is stubbed with vi.fn — tests don't actually hit the
// network; they assert the helper builds the right request shape
// and parses the right response shape.

const sample = {
  publicKey: "BJk1234567890abcdefghijklmnopqrstuv-_wxyzABC",
};

beforeEach(() => {
  localStorage.clear();
  clearVapidPublicKeyCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

// ── #181 harness: mock ONLY the browser push boundary ──────────────────
// (pushManager / Notification / fetch); the real push.ts handlers run.
const SUB_ID_KEY = "cic.pushSubscriptionId";
const SUB_ENDPOINT_KEY = "cic.pushSubscriptionEndpoint";

function fakeSub(endpoint: string): PushSubscription {
  return {
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: "P256DH", auth: "AUTHSECRET" } }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  } as unknown as PushSubscription;
}

function stubPushEnv(opts: {
  permission?: NotificationPermission;
  existingSubscription?: PushSubscription | null;
  subscribeResult?: PushSubscription;
}): { getSubscription: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> } {
  const getSubscription = vi.fn().mockResolvedValue(opts.existingSubscription ?? null);
  const subscribe = vi
    .fn()
    .mockResolvedValue(opts.subscribeResult ?? fakeSub("https://push.example/NEW"));
  const registration = { pushManager: { getSubscription, subscribe } };
  vi.stubGlobal("Notification", {
    permission: opts.permission ?? "granted",
    requestPermission: vi.fn(),
  });
  vi.stubGlobal("navigator", {
    serviceWorker: {
      ready: Promise.resolve(registration),
      controller: {},
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
  return { getSubscription, subscribe };
}

// Route fetch by URL: VAPID key GET, subscription POST, subscription DELETE.
function stubPushFetch(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL, init?) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/push/vapid-public-key")) {
      return Promise.resolve(
        new Response(JSON.stringify({ public_key: sample.publicKey }), { status: 200 }),
      );
    }
    if (url === "/push/subscriptions" && method === "POST") {
      return Promise.resolve(
        new Response(JSON.stringify({ id: "srv-new", created_at: "2026-07-04T00:00:00Z" }), {
          status: 201,
        }),
      );
    }
    if (url.startsWith("/push/subscriptions/") && method === "DELETE") {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return Promise.resolve(new Response("unexpected", { status: 500 }));
  });
}

describe("disablePush — #181: DELETE the stashed row, never orphan it", () => {
  it("DELETEs the stashed server id when getSubscription() is null (silent drop)", async () => {
    // The exact ghost path: the browser subscription vanished (iOS SW-swap),
    // so the pre-#181 code forgot the stashed id WITHOUT deleting the row →
    // the push service keeps 2xx-ing a dead endpoint forever.
    localStorage.setItem(SUB_ID_KEY, "srv-ghost");
    localStorage.setItem(SUB_ENDPOINT_KEY, "https://push.example/OLD");
    const fetchMock = stubPushFetch();
    stubPushEnv({ existingSubscription: null });

    const removed = await disablePush("tok");

    expect(fetchMock).toHaveBeenCalledWith(
      "/push/subscriptions/srv-ghost",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(localStorage.getItem(SUB_ID_KEY)).toBeNull();
    expect(localStorage.getItem(SUB_ENDPOINT_KEY)).toBeNull();
    expect(removed).toBe(false);
  });

  it("no server DELETE when there is no stashed id to clean up", async () => {
    const fetchMock = stubPushFetch();
    stubPushEnv({ existingSubscription: null });
    await disablePush("tok");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("ensurePushSubscription — #181: renew a dropped-but-wanted subscription", () => {
  it("re-subscribes and POSTs supersedes=<old endpoint> on a silent drop", async () => {
    localStorage.setItem(SUB_ID_KEY, "srv-old");
    localStorage.setItem(SUB_ENDPOINT_KEY, "https://push.example/OLD");
    const fetchMock = stubPushFetch();
    stubPushEnv({
      permission: "granted",
      existingSubscription: null,
      subscribeResult: fakeSub("https://push.example/NEW"),
    });

    const outcome = await ensurePushSubscription("tok");

    expect(outcome).toBe("renewed");
    const post = fetchMock.mock.calls.find(
      (call: unknown[]) =>
        call[0] === "/push/subscriptions" &&
        (call[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(post).toBeDefined();
    const body = JSON.parse((post![1] as RequestInit).body as string);
    expect(body.endpoint).toBe("https://push.example/NEW");
    expect(body.supersedes).toBe("https://push.example/OLD");
    // fresh server id + endpoint stashed for the next cycle
    expect(localStorage.getItem(SUB_ID_KEY)).toBe("srv-new");
    expect(localStorage.getItem(SUB_ENDPOINT_KEY)).toBe("https://push.example/NEW");
  });

  it("no-ops when a live subscription is already present", async () => {
    localStorage.setItem(SUB_ID_KEY, "srv-old");
    localStorage.setItem(SUB_ENDPOINT_KEY, "https://push.example/LIVE");
    const fetchMock = stubPushFetch();
    stubPushEnv({
      permission: "granted",
      existingSubscription: fakeSub("https://push.example/LIVE"),
    });

    expect(await ensurePushSubscription("tok")).toBe("present");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips (never prompts) when permission is not granted", async () => {
    localStorage.setItem(SUB_ENDPOINT_KEY, "https://push.example/OLD");
    const fetchMock = stubPushFetch();
    stubPushEnv({ permission: "default", existingSubscription: null });
    expect(await ensurePushSubscription("tok")).toBe("skipped");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing when the user never opted in (no stashed endpoint = no intent)", async () => {
    const fetchMock = stubPushFetch();
    stubPushEnv({ permission: "granted", existingSubscription: null });
    expect(await ensurePushSubscription("tok")).toBe("no-intent");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getVapidPublicKey", () => {
  it("fetches + caches on first call", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ public_key: sample.publicKey }), { status: 200 }),
      );

    expect(await getVapidPublicKey()).toBe(sample.publicKey);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("cic.vapidPublicKey")).toBe(sample.publicKey);
  });

  it("returns cached value on subsequent calls without fetching", async () => {
    localStorage.setItem("cic.vapidPublicKey", sample.publicKey);
    const fetchMock = vi.spyOn(globalThis, "fetch");

    expect(await getVapidPublicKey()).toBe(sample.publicKey);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forceRefresh bypasses the cache", async () => {
    localStorage.setItem("cic.vapidPublicKey", "stale-value");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ public_key: sample.publicKey }), { status: 200 }),
      );

    expect(await getVapidPublicKey(true)).toBe(sample.publicKey);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("cic.vapidPublicKey")).toBe(sample.publicKey);
  });

  it("throws ApiError on non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(getVapidPublicKey()).rejects.toThrow(/500/);
  });

  it("throws ApiError on malformed body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    await expect(getVapidPublicKey()).rejects.toThrow(/vapid_malformed/);
  });
});

describe("vapidKeyToUint8Array", () => {
  it("decodes a padded base64url string", () => {
    // "Hello!" base64 = "SGVsbG8h"
    const out = vapidKeyToUint8Array("SGVsbG8h");
    expect(Array.from(out)).toEqual([72, 101, 108, 108, 111, 33]);
  });

  it("decodes an unpadded base64url string (server emits no padding)", () => {
    // "Hi" base64 = "SGk=" → unpadded "SGk"
    const out = vapidKeyToUint8Array("SGk");
    expect(Array.from(out)).toEqual([72, 105]);
  });

  it("translates url-safe -/_ back to standard +/", () => {
    // base64url "-_-_" → standard "+/+/" → 3 bytes [0xfb, 0xff, 0xbf]
    const out = vapidKeyToUint8Array("-_-_");
    expect(Array.from(out)).toEqual([251, 255, 191]);
  });
});

describe("postPushSubscription", () => {
  it("POSTs the W3C subscription shape with bearer auth + returns parsed body", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "abc-123", created_at: "2026-05-14T12:00:00Z" }), {
        status: 201,
      }),
    );

    const body = {
      endpoint: "https://fcm.googleapis.com/wp/abc",
      keys: { p256dh: "BPub...", auth: "auth-secret" },
    };

    const result = await postPushSubscription("token-xyz", body);

    expect(result).toEqual({ id: "abc-123", created_at: "2026-05-14T12:00:00Z" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/push/subscriptions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(body),
        headers: expect.objectContaining({
          "content-type": "application/json",
          authorization: "Bearer token-xyz",
        }),
      }),
    );
  });

  it("throws ApiError carrying server error code on 422", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "validation_failed",
          field_errors: { endpoint: ["has already been taken"] },
        }),
        { status: 422 },
      ),
    );

    const body = {
      endpoint: "https://fcm.googleapis.com/wp/abc",
      keys: { p256dh: "x", auth: "y" },
    };

    await expect(postPushSubscription("token", body)).rejects.toThrow(/validation_failed/);
  });
});

describe("deletePushSubscription", () => {
  it("DELETE /push/subscriptions/:id with bearer auth", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    await deletePushSubscription("token-xyz", "abc-123" as SubscriptionId);

    expect(fetchMock).toHaveBeenCalledWith(
      "/push/subscriptions/abc-123",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({ authorization: "Bearer token-xyz" }),
      }),
    );
  });

  it("URL-encodes the id segment", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    await deletePushSubscription("token", "with spaces" as SubscriptionId);

    expect(fetchMock).toHaveBeenCalledWith("/push/subscriptions/with%20spaces", expect.anything());
  });

  it("throws ApiError on 404", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not found", { status: 404 }));
    await expect(deletePushSubscription("token", "id" as SubscriptionId)).rejects.toThrow(/404/);
  });
});

describe("listPushDevices", () => {
  it("returns the subscriptions array", async () => {
    const subs = [
      {
        id: "abc",
        user_agent: "Mozilla/5.0 ...",
        created_at: "2026-05-14T10:00:00Z",
        last_used_at: null,
      },
    ];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ subscriptions: subs }), { status: 200 }),
    );

    expect(await listPushDevices("token")).toEqual(subs);
  });

  it("returns [] when subscriptions key is absent (defensive)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    expect(await listPushDevices("token")).toEqual([]);
  });
});

// #459 — pushAvailable(): the ONE synchronous capability gate reused by both
// the login opt-in banner (errorBanners) and the settings master toggle.
// Synchronous is load-bearing: the banner's [of course!] click calls
// Notification.requestPermission() before its first await, and a Safari
// permission prompt requires the user gesture — an async availability probe
// would spend the gesture. iOS Web Push fires ONLY for a home-screen-installed
// (standalone) PWA, so on iOS the gate additionally requires isStandalonePwa().
describe("pushAvailable — synchronous capability gate (#459)", () => {
  const stubEnv = (over: Record<string, unknown> = {}): void => {
    vi.stubGlobal("Notification", { permission: "default", requestPermission: vi.fn() });
    vi.stubGlobal("PushManager", function PushManager() {});
    vi.stubGlobal("navigator", {
      serviceWorker: {},
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0",
      maxTouchPoints: 0,
      ...over,
    });
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false })),
    );
  };

  it("is true on a desktop browser with Notification + serviceWorker + PushManager", () => {
    stubEnv();
    expect(pushAvailable()).toBe(true);
  });

  it("is false when Notification is absent", () => {
    stubEnv();
    vi.stubGlobal("Notification", undefined);
    expect(pushAvailable()).toBe(false);
  });

  it("is false when navigator.serviceWorker is absent", () => {
    stubEnv({ serviceWorker: undefined });
    expect(pushAvailable()).toBe(false);
  });

  it("is false when PushManager is absent", () => {
    stubEnv();
    vi.stubGlobal("PushManager", undefined);
    expect(pushAvailable()).toBe(false);
  });

  it("is false on iOS Safari in a browser tab (not installed to home screen)", () => {
    stubEnv({
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit Safari",
      standalone: false,
    });
    expect(pushAvailable()).toBe(false);
  });

  it("is true on iOS ONLY when installed as a standalone PWA", () => {
    stubEnv({
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit Safari",
      standalone: true,
    });
    expect(pushAvailable()).toBe(true);
  });
});

// ── #964 — the device row's disambiguating metadata ────────────────────
// Two rows reading "Firefox on Linux" are byte-identical today. The
// payload already carries `created_at` + `last_used_at`; these two
// helpers turn them (and "which row am I?") into row-level strings.

describe("formatDeviceActivity — #964: the row's activity line", () => {
  const NOW = Date.parse("2026-08-07T12:00:00Z");

  const device = (over: Partial<PushDeviceSummary>): PushDeviceSummary => ({
    id: "sub-1" as SubscriptionId,
    user_agent: "Mozilla/5.0 (X11; Linux x86_64) Firefox/128.0",
    label: null,
    created_at: "2026-08-07T11:00:00Z",
    last_used_at: null,
    ...over,
  });

  it("renders last_used_at when the device has been pushed to", () => {
    expect(formatDeviceActivity(device({ last_used_at: "2026-08-07T07:48:00Z" }), NOW)).toBe(
      "last used 4h 12m ago",
    );
  });

  it("falls back to created_at when the device has never been pushed to", () => {
    expect(formatDeviceActivity(device({ created_at: "2026-08-07T11:57:00Z" }), NOW)).toBe(
      "added 3m ago",
    );
  });

  it("prefers last_used_at over created_at when both are present", () => {
    expect(
      formatDeviceActivity(
        device({ created_at: "2026-08-01T12:00:00Z", last_used_at: "2026-08-07T11:59:15Z" }),
        NOW,
      ),
    ).toBe("last used 45s ago");
  });

  it("clamps a future instant (clock skew) instead of going negative", () => {
    expect(formatDeviceActivity(device({ last_used_at: "2026-08-07T12:30:00Z" }), NOW)).toBe(
      "last used 0s ago",
    );
  });

  it("returns null when neither instant parses (omit the line, never guess)", () => {
    expect(formatDeviceActivity(device({ created_at: "not-a-date" }), NOW)).toBeNull();
  });
});

describe("subscriptionIdForEndpoint — #964: which row is THIS device", () => {
  it("returns the stashed id when the endpoint matches", () => {
    localStorage.setItem(SUB_ID_KEY, "sub-42");
    localStorage.setItem(SUB_ENDPOINT_KEY, "https://push.example/ep");
    expect(subscriptionIdForEndpoint("https://push.example/ep")).toBe("sub-42");
  });

  it("returns null when the live endpoint is not the one we stashed", () => {
    localStorage.setItem(SUB_ID_KEY, "sub-42");
    localStorage.setItem(SUB_ENDPOINT_KEY, "https://push.example/old");
    expect(subscriptionIdForEndpoint("https://push.example/new")).toBeNull();
  });

  it("returns null when nothing was ever stashed", () => {
    expect(subscriptionIdForEndpoint("https://push.example/ep")).toBeNull();
  });
});

// ── #964 — the row's NAME: user label first, derived ordinal otherwise ──
// The label is the only stored piece; the ordinal is derived on every
// render precisely so deleting a twin cannot strand a lone "#2".

describe("deviceRows — #964: the name the device row prints", () => {
  const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64) Firefox/128.0";
  const CHROME_MAC =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36";

  const dev = (
    over: Omit<Partial<PushDeviceSummary>, "id"> & { id: string },
  ): PushDeviceSummary => ({
    user_agent: FIREFOX_LINUX,
    label: null,
    created_at: "2026-08-07T11:00:00Z",
    last_used_at: null,
    ...over,
    id: over.id as SubscriptionId,
  });

  const nameOf = (rows: ReturnType<typeof deviceRows>, id: string): string | undefined =>
    rows.find((r) => r.device.id === (id as SubscriptionId))?.displayName;

  it("prints the parsed name, with NO ordinal, for a device alone in its group", () => {
    const rows = deviceRows([dev({ id: "a" })]);
    expect(rows.map((r) => r.displayName)).toEqual(["Firefox on Linux"]);
    expect(rows[0]?.named).toBe(false);
  });

  it("prints no ordinal when the two devices parse differently", () => {
    const rows = deviceRows([dev({ id: "a" }), dev({ id: "b", user_agent: CHROME_MAC })]);
    expect(rows.map((r) => r.displayName)).toEqual(["Firefox on Linux", "Chrome on macOS"]);
  });

  it("numbers twins oldest-first, regardless of the order the server sent them", () => {
    // Server order is newest-first, so the NEWER row arrives at index 0 —
    // if the ordinal followed list position instead of created_at, the
    // older device would be #2 and the numbers would flip whenever the
    // list is re-sorted.
    const rows = deviceRows([
      dev({ id: "new", created_at: "2026-08-07T11:00:00Z" }),
      dev({ id: "old", created_at: "2026-08-01T09:00:00Z" }),
    ]);
    expect(nameOf(rows, "old")).toBe("Firefox on Linux #1");
    expect(nameOf(rows, "new")).toBe("Firefox on Linux #2");
  });

  it("keeps existing ordinals stable when a newer twin appears", () => {
    const older = dev({ id: "old", created_at: "2026-08-01T09:00:00Z" });
    const newer = dev({ id: "new", created_at: "2026-08-07T11:00:00Z" });
    const third = dev({ id: "third", created_at: "2026-08-09T09:00:00Z" });

    const before = deviceRows([newer, older]);
    const after = deviceRows([third, newer, older]);

    expect(nameOf(before, "old")).toBe(nameOf(after, "old"));
    expect(nameOf(before, "new")).toBe(nameOf(after, "new"));
    expect(nameOf(after, "third")).toBe("Firefox on Linux #3");
  });

  it("re-derives after a deletion instead of stranding a lone #2", () => {
    // THE reason the ordinal is not a column: delete #1 and a stored #2
    // has nobody to be second to. Derived, the survivor is alone in its
    // group and drops the suffix entirely.
    const older = dev({ id: "old", created_at: "2026-08-01T09:00:00Z" });
    const newer = dev({ id: "new", created_at: "2026-08-07T11:00:00Z" });

    expect(nameOf(deviceRows([newer, older]), "new")).toBe("Firefox on Linux #2");
    expect(nameOf(deviceRows([newer]), "new")).toBe("Firefox on Linux");
  });

  it("numbers each colliding group independently", () => {
    const rows = deviceRows([
      dev({ id: "f1", created_at: "2026-08-01T09:00:00Z" }),
      dev({ id: "f2", created_at: "2026-08-02T09:00:00Z" }),
      dev({ id: "c1", user_agent: CHROME_MAC, created_at: "2026-08-03T09:00:00Z" }),
      dev({ id: "c2", user_agent: CHROME_MAC, created_at: "2026-08-04T09:00:00Z" }),
    ]);
    expect(nameOf(rows, "f1")).toBe("Firefox on Linux #1");
    expect(nameOf(rows, "f2")).toBe("Firefox on Linux #2");
    expect(nameOf(rows, "c1")).toBe("Chrome on macOS #1");
    expect(nameOf(rows, "c2")).toBe("Chrome on macOS #2");
  });

  it("the user's label wins over the derived name", () => {
    const rows = deviceRows([
      dev({ id: "a", label: "MacBook del lavoro", created_at: "2026-08-01T09:00:00Z" }),
      dev({ id: "b", created_at: "2026-08-02T09:00:00Z" }),
    ]);
    expect(nameOf(rows, "a")).toBe("MacBook del lavoro");
    expect(rows.find((r) => r.device.id === ("a" as SubscriptionId))?.named).toBe(true);
  });

  it("naming one twin leaves the other WITHOUT an orphan ordinal", () => {
    // The pair is no longer ambiguous on screen, so the survivor must not
    // keep a "#2" that has nothing to contrast with.
    const rows = deviceRows([
      dev({ id: "named", label: "fisso", created_at: "2026-08-01T09:00:00Z" }),
      dev({ id: "bare", created_at: "2026-08-02T09:00:00Z" }),
    ]);
    expect(nameOf(rows, "bare")).toBe("Firefox on Linux");
  });

  it("still numbers the two that remain unlabelled among three twins", () => {
    const rows = deviceRows([
      dev({ id: "named", label: "fisso", created_at: "2026-08-01T09:00:00Z" }),
      dev({ id: "x", created_at: "2026-08-02T09:00:00Z" }),
      dev({ id: "y", created_at: "2026-08-03T09:00:00Z" }),
    ]);
    expect(nameOf(rows, "x")).toBe("Firefox on Linux #1");
    expect(nameOf(rows, "y")).toBe("Firefox on Linux #2");
  });

  it("preserves the server's row order (newest first)", () => {
    const rows = deviceRows([
      dev({ id: "new", created_at: "2026-08-07T11:00:00Z" }),
      dev({ id: "old", created_at: "2026-08-01T09:00:00Z" }),
    ]);
    expect(rows.map((r) => r.device.id)).toEqual(["new", "old"]);
  });

  it("falls back to the id for a total order when created_at does not parse", () => {
    const rows = deviceRows([
      dev({ id: "b", created_at: "not-a-date" }),
      dev({ id: "a", created_at: "not-a-date" }),
    ]);
    expect(nameOf(rows, "a")).toBe("Firefox on Linux #1");
    expect(nameOf(rows, "b")).toBe("Firefox on Linux #2");
  });

  it("groups two unparseable user agents together rather than splitting them", () => {
    const rows = deviceRows([
      dev({ id: "a", user_agent: null, created_at: "2026-08-01T09:00:00Z" }),
      dev({ id: "b", user_agent: "", created_at: "2026-08-02T09:00:00Z" }),
    ]);
    expect(nameOf(rows, "a")).toBe("Unknown browser on Unknown OS #1");
    expect(nameOf(rows, "b")).toBe("Unknown browser on Unknown OS #2");
  });

  it("returns an empty list for an empty device list", () => {
    expect(deviceRows([])).toEqual([]);
  });
});
