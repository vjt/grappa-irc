import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_NOTIFICATION_PREFS,
  getNotificationPrefs,
  putNotificationPrefs,
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
