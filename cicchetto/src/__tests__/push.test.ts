import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearVapidPublicKeyCache,
  deletePushSubscription,
  disablePush,
  ensurePushSubscription,
  getVapidPublicKey,
  listPushDevices,
  postPushSubscription,
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
    const body = JSON.parse((post?.[1] as RequestInit).body as string);
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

    await deletePushSubscription("token-xyz", "abc-123");

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

    await deletePushSubscription("token", "with spaces");

    expect(fetchMock).toHaveBeenCalledWith("/push/subscriptions/with%20spaces", expect.anything());
  });

  it("throws ApiError on 404", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not found", { status: 404 }));
    await expect(deletePushSubscription("token", "id")).rejects.toThrow(/404/);
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
