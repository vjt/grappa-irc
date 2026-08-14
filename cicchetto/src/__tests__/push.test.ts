import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deletePushSubscription,
  disablePush,
  enablePush,
  ensurePushSubscription,
  fetchVapidPublicKey,
  formatDeviceActivity,
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

// #1323 — the key the operator rotated TO. Same length class as `sample`
// so both decode cleanly through `vapidKeyToUint8Array`.
const ROTATED_KEY = "BRotated9876543210zyxwvutsrqponmlkjihgfe-_AB";

beforeEach(() => {
  localStorage.clear();
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
// #1323 — the key the LIVE subscription was created with (not a read-through
// cache: nothing is ever served from it).
const SUBSCRIBED_KEY = "cic.vapidPublicKey";

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

// The body of the `POST /push/subscriptions` the run made, or null when it
// registered nothing.
function postedSubscription(
  fetchMock: ReturnType<typeof vi.spyOn>,
): { endpoint?: string; supersedes?: string } | null {
  const call = fetchMock.mock.calls.find(
    (args: unknown[]) =>
      args[0] === "/push/subscriptions" && (args[1] as RequestInit | undefined)?.method === "POST",
  ) as [string, RequestInit] | undefined;
  return call === undefined ? null : JSON.parse(call[1].body as string);
}

// The application server key bytes handed to the FIRST `pushManager.subscribe`
// call — the assertion that says WHICH VAPID key a subscription was born with.
function firstSubscribeKeyBytes(subscribe: ReturnType<typeof vi.fn>): number[] {
  const [options] = subscribe.mock.calls[0] as [PushSubscriptionOptionsInit];
  return Array.from(options.applicationServerKey as Uint8Array);
}

// Route fetch by URL: VAPID key GET, subscription POST, subscription DELETE.
// `servedKey` is what the server currently signs with — the axis #1323 turns on.
function stubPushFetch(servedKey: string): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL, init?) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/push/vapid-public-key")) {
      return Promise.resolve(
        new Response(JSON.stringify({ public_key: servedKey }), { status: 200 }),
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
    const fetchMock = stubPushFetch(sample.publicKey);
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
    const fetchMock = stubPushFetch(sample.publicKey);
    stubPushEnv({ existingSubscription: null });
    await disablePush("tok");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("ensurePushSubscription — #181: renew a dropped-but-wanted subscription", () => {
  it("re-subscribes and POSTs supersedes=<old endpoint> on a silent drop", async () => {
    localStorage.setItem(SUB_ID_KEY, "srv-old");
    localStorage.setItem(SUB_ENDPOINT_KEY, "https://push.example/OLD");
    const fetchMock = stubPushFetch(sample.publicKey);
    stubPushEnv({
      permission: "granted",
      existingSubscription: null,
      subscribeResult: fakeSub("https://push.example/NEW"),
    });

    const outcome = await ensurePushSubscription("tok");

    expect(outcome).toBe("renewed");
    const body = postedSubscription(fetchMock);
    expect(body?.endpoint).toBe("https://push.example/NEW");
    expect(body?.supersedes).toBe("https://push.example/OLD");
    // fresh server id + endpoint stashed for the next cycle, plus (#1323) the
    // key this subscription was created with.
    expect(localStorage.getItem(SUB_ID_KEY)).toBe("srv-new");
    expect(localStorage.getItem(SUB_ENDPOINT_KEY)).toBe("https://push.example/NEW");
    expect(localStorage.getItem(SUBSCRIBED_KEY)).toBe(sample.publicKey);
  });

  it("keeps a live subscription whose key still matches what the server serves", async () => {
    localStorage.setItem(SUB_ID_KEY, "srv-old");
    localStorage.setItem(SUB_ENDPOINT_KEY, "https://push.example/LIVE");
    localStorage.setItem(SUBSCRIBED_KEY, sample.publicKey);
    const fetchMock = stubPushFetch(sample.publicKey);
    const live = fakeSub("https://push.example/LIVE");
    const { subscribe } = stubPushEnv({ permission: "granted", existingSubscription: live });

    expect(await ensurePushSubscription("tok")).toBe("present");

    // #1323 — the key IS revalidated (one GET), it just matched: nothing is
    // torn down and no row is registered.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/push/vapid-public-key");
    expect(vi.mocked(live.unsubscribe)).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("skips (never prompts) when permission is not granted", async () => {
    localStorage.setItem(SUB_ENDPOINT_KEY, "https://push.example/OLD");
    const fetchMock = stubPushFetch(sample.publicKey);
    stubPushEnv({ permission: "default", existingSubscription: null });
    expect(await ensurePushSubscription("tok")).toBe("skipped");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing when the user never opted in (no stashed endpoint = no intent)", async () => {
    const fetchMock = stubPushFetch(sample.publicKey);
    stubPushEnv({ permission: "granted", existingSubscription: null });
    expect(await ensurePushSubscription("tok")).toBe("no-intent");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── #1323 — a rotated VAPID key must heal itself, with no user gesture ──
// Measured on staging: a subscription created with key A can never be signed
// for once the server serves key B (`400 VapidPkHashMismatch` from Apple,
// `403` from FCM). The client held the old key in localStorage and never
// looked again, so nothing on either side reconciled — push died silently and
// permanently. These tests pin the reconciliation at both doors.
describe("#1323 — VAPID rotation heals on the ensure seam", () => {
  it("drops the stale subscription and re-subscribes with the served key", async () => {
    localStorage.setItem(SUB_ID_KEY, "srv-old");
    localStorage.setItem(SUB_ENDPOINT_KEY, "https://push.example/OLD");
    localStorage.setItem(SUBSCRIBED_KEY, sample.publicKey);
    const fetchMock = stubPushFetch(ROTATED_KEY);
    const live = fakeSub("https://push.example/OLD");
    const { subscribe } = stubPushEnv({
      permission: "granted",
      existingSubscription: live,
      subscribeResult: fakeSub("https://push.example/NEW"),
    });

    expect(await ensurePushSubscription("tok")).toBe("rekeyed");

    expect(vi.mocked(live.unsubscribe)).toHaveBeenCalled();
    expect(firstSubscribeKeyBytes(subscribe)).toEqual(
      Array.from(vapidKeyToUint8Array(ROTATED_KEY)),
    );
    expect(postedSubscription(fetchMock)?.endpoint).toBe("https://push.example/NEW");
    // The record now names the key the LIVE subscription was created with.
    expect(localStorage.getItem(SUBSCRIBED_KEY)).toBe(ROTATED_KEY);
    expect(localStorage.getItem(SUB_ENDPOINT_KEY)).toBe("https://push.example/NEW");
  });

  it("leaves the recorded key untouched when the re-subscribe fails", async () => {
    // Recording the served key before the subscribe succeeds would re-create
    // the #1323 silence one seam later: the next pass would see
    // recorded == served, answer "present", and never heal.
    localStorage.setItem(SUB_ID_KEY, "srv-old");
    localStorage.setItem(SUB_ENDPOINT_KEY, "https://push.example/OLD");
    localStorage.setItem(SUBSCRIBED_KEY, sample.publicKey);
    stubPushFetch(ROTATED_KEY);
    const { subscribe } = stubPushEnv({
      permission: "granted",
      existingSubscription: fakeSub("https://push.example/OLD"),
    });
    subscribe.mockRejectedValue(new Error("subscribe blew up"));

    await expect(ensurePushSubscription("tok")).rejects.toThrow(/subscribe blew up/);

    expect(localStorage.getItem(SUBSCRIBED_KEY)).toBe(sample.publicKey);
  });
});

describe("#1323 — enablePush subscribes with the served key, never a recorded one", () => {
  it("drops a subscription bound to a superseded key before subscribing", async () => {
    localStorage.setItem(SUB_ID_KEY, "srv-old");
    localStorage.setItem(SUB_ENDPOINT_KEY, "https://push.example/OLD");
    localStorage.setItem(SUBSCRIBED_KEY, sample.publicKey);
    stubPushFetch(ROTATED_KEY);
    const live = fakeSub("https://push.example/OLD");
    const { subscribe } = stubPushEnv({
      permission: "granted",
      existingSubscription: live,
      subscribeResult: fakeSub("https://push.example/NEW"),
    });

    expect(await enablePush("tok")).toEqual({ status: "enabled", subscriptionId: "srv-new" });

    expect(vi.mocked(live.unsubscribe)).toHaveBeenCalled();
    expect(firstSubscribeKeyBytes(subscribe)).toEqual(
      Array.from(vapidKeyToUint8Array(ROTATED_KEY)),
    );
    expect(localStorage.getItem(SUBSCRIBED_KEY)).toBe(ROTATED_KEY);
  });

  it("unsubscribes the conflicting subscription when the browser raises InvalidAccessError", async () => {
    // The browser's own guard: an existing subscription bound to another key.
    // Re-fetching the key cannot clear it — only unsubscribing can.
    stubPushFetch(sample.publicKey);
    const conflicting = fakeSub("https://push.example/CONFLICT");
    const { subscribe } = stubPushEnv({
      permission: "granted",
      existingSubscription: conflicting,
    });
    subscribe
      .mockRejectedValueOnce(new DOMException("different key", "InvalidAccessError"))
      .mockResolvedValue(fakeSub("https://push.example/NEW"));

    expect(await enablePush("tok")).toEqual({ status: "enabled", subscriptionId: "srv-new" });

    expect(vi.mocked(conflicting.unsubscribe)).toHaveBeenCalled();
    expect(subscribe).toHaveBeenCalledTimes(2);
  });
});

describe("fetchVapidPublicKey", () => {
  it("always GETs — a recorded key is never served in its place (#1323)", async () => {
    localStorage.setItem(SUBSCRIBED_KEY, "stale-value");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ public_key: sample.publicKey }), { status: 200 }),
      );

    expect(await fetchVapidPublicKey()).toBe(sample.publicKey);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Reading the key does NOT record it: only a successful subscribe does.
    expect(localStorage.getItem(SUBSCRIBED_KEY)).toBe("stale-value");
  });

  it("throws ApiError on non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(fetchVapidPublicKey()).rejects.toThrow(/500/);
  });

  it("throws ApiError on malformed body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    await expect(fetchVapidPublicKey()).rejects.toThrow(/vapid_malformed/);
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
