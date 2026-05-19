import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_NOTIFICATION_PREFS,
  getNotificationPrefs,
  getUploadTtlSeconds,
  putNotificationPrefs,
  putUploadTtlSeconds,
} from "../lib/userSettings";

// User settings client — push-notifications cluster B3 (2026-05-14).
//
// Coverage: GET round-trip, PUT round-trip + body shape, error paths.
// fetch is stubbed; tests assert request shape + parsed response shape.

const TOKEN = "test-bearer";

const sample = {
  channel_messages_all: false,
  channel_messages_only: ["#sbiffo"],
  channel_mentions: true,
  private_messages_all: true,
  private_messages_only: [],
};

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("DEFAULT_NOTIFICATION_PREFS", () => {
  it("matches the documented default shape", () => {
    expect(DEFAULT_NOTIFICATION_PREFS).toEqual({
      channel_messages_all: false,
      channel_messages_only: [],
      channel_mentions: true,
      private_messages_all: true,
      private_messages_only: [],
    });
  });
});

describe("getNotificationPrefs", () => {
  it("GETs /me/settings/notification-prefs with bearer", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ notification_prefs: sample }), { status: 200 }),
      );

    const result = await getNotificationPrefs(TOKEN);
    expect(result).toEqual(sample);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/me/settings/notification-prefs");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("throws ApiError on non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(getNotificationPrefs(TOKEN)).rejects.toThrow(/500/);
  });
});

describe("putNotificationPrefs", () => {
  it("PUTs prefs as JSON body and returns server-normalized shape", async () => {
    const normalized = { ...sample, channel_messages_only: ["#sbiffo", "#italia"] };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ notification_prefs: normalized }), { status: 200 }),
      );

    const result = await putNotificationPrefs(TOKEN, sample);
    expect(result).toEqual(normalized);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/me/settings/notification-prefs");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual(sample);
  });

  it("throws ApiError carrying field_errors on 422", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "validation_failed",
          field_errors: { notification_prefs: ["at least one trigger must be enabled"] },
        }),
        { status: 422 },
      ),
    );

    await expect(putNotificationPrefs(TOKEN, sample)).rejects.toMatchObject({
      status: 422,
      code: "validation_failed",
    });
  });
});

// UX-4 bucket M (2026-05-19) — upload-TTL REST wrappers.
describe("getUploadTtlSeconds", () => {
  it("GETs /me/settings/upload-ttl-seconds with bearer", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ upload_ttl_seconds: 3600 }), { status: 200 }),
      );

    const result = await getUploadTtlSeconds(TOKEN);
    expect(result).toBe(3600);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/me/settings/upload-ttl-seconds");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("returns null when the server has no preference set", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ upload_ttl_seconds: null }), { status: 200 }),
    );
    expect(await getUploadTtlSeconds(TOKEN)).toBeNull();
  });

  it("throws ApiError on non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(getUploadTtlSeconds(TOKEN)).rejects.toThrow(/500/);
  });
});

describe("putUploadTtlSeconds", () => {
  it("PUTs integer seconds as JSON body", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ upload_ttl_seconds: 43_200 }), { status: 200 }),
      );

    const result = await putUploadTtlSeconds(TOKEN, 43_200);
    expect(result).toBe(43_200);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/me/settings/upload-ttl-seconds");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ upload_ttl_seconds: 43_200 });
  });

  it("PUTs null to clear the preference", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ upload_ttl_seconds: null }), { status: 200 }),
      );

    const result = await putUploadTtlSeconds(TOKEN, null);
    expect(result).toBeNull();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ upload_ttl_seconds: null });
  });

  it("throws ApiError carrying field_errors on 422", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "validation_failed",
          field_errors: { upload_ttl_seconds: ["must be positive"] },
        }),
        { status: 422 },
      ),
    );

    await expect(putUploadTtlSeconds(TOKEN, -1)).rejects.toMatchObject({
      status: 422,
      code: "validation_failed",
    });
  });
});
