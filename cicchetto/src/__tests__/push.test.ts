import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearVapidPublicKeyCache,
  deletePushSubscription,
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
  localStorage.clear();
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
