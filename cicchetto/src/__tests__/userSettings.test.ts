import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setOn401Handler } from "../lib/api";
import {
  DEFAULT_NOTIFICATION_PREFS,
  getAliases,
  getDisplayPrefs,
  getNotificationPrefs,
  getUploadTtlSeconds,
  putAliases,
  putDisplayPrefs,
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
  setOn401Handler(null); // don't leak a spy handler into sibling tests
});

describe("DEFAULT_NOTIFICATION_PREFS", () => {
  it("matches the documented default shape", () => {
    expect(DEFAULT_NOTIFICATION_PREFS).toEqual({
      channel_messages_all: false,
      channel_messages_only: [],
      channel_mentions: true,
      private_messages_all: true,
      private_messages_only: [],
      // #866 — nothing muted by default. This map must stay byte-identical to
      // the server's `UserSettings.default_notification_prefs/0`: it is what
      // an un-hydrated client decides beeps with, so a divergence here means
      // the client is silently stricter (or looser) than the push it mirrors.
      muted_targets: {},
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

// #385 — user-defined command aliases REST wrappers.
describe("getAliases", () => {
  it("GETs /me/settings/aliases with bearer and returns the map", async () => {
    const map = { wii: "whois $1 $1" };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ aliases: map }), { status: 200 }));

    const result = await getAliases(TOKEN);
    expect(result).toEqual(map);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/me/settings/aliases");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("throws ApiError on non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(getAliases(TOKEN)).rejects.toThrow(/500/);
  });
});

describe("putAliases", () => {
  it("PUTs the map wrapped under `aliases` and returns the normalized shape", async () => {
    const normalized = { wii: "whois $1 $1" };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ aliases: normalized }), { status: 200 }));

    const result = await putAliases(TOKEN, { WII: "whois $1 $1" });
    expect(result).toEqual(normalized);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/me/settings/aliases");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ aliases: { WII: "whois $1 $1" } });
  });

  it("PUTs an empty map (clear all) wrapped under `aliases`", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ aliases: {} }), { status: 200 }));

    const result = await putAliases(TOKEN, {});
    expect(result).toEqual({});

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ aliases: {} });
  });

  it("throws ApiError carrying field_errors on 422", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "validation_failed",
          field_errors: { aliases: ["alias name must not contain whitespace"] },
        }),
        { status: 422 },
      ),
    );

    await expect(putAliases(TOKEN, { "wi i": "whois" })).rejects.toMatchObject({
      status: 422,
      code: "validation_failed",
    });
  });
});

// #449 — display-prefs are boot-APPLIED cosmetic state: `mountDisplayPrefsSync`
// fires GET/PUT on EVERY token presence (login, reload, cold boot). A cosmetic
// pref sync must NEVER be able to kill a valid session, so its 401 path is
// ISOLATED from the shared dead-token handler: a transient 401 there throws a
// normal error (the coordinator keeps the boot cache) but does NOT clear the
// token. Contrast: on-demand settings verbs (notification-prefs, aliases, …)
// keep the handler — a 401 while the user is actively in Settings genuinely
// means the session is dead.
describe("display-prefs fetches are isolated from the dead-token handler (#449)", () => {
  const DP = { time_format: "hms", colored_nicklist: false, presence_filter: {} } as const;

  it("getDisplayPrefs on 401 throws but does NOT fire the on401 dead-token handler", async () => {
    const on401 = vi.fn();
    setOn401Handler(on401);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    );

    await expect(getDisplayPrefs(TOKEN)).rejects.toBeDefined();
    expect(on401).not.toHaveBeenCalled();
  });

  it("putDisplayPrefs on 401 throws but does NOT fire the on401 dead-token handler", async () => {
    const on401 = vi.fn();
    setOn401Handler(on401);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    );

    await expect(putDisplayPrefs(TOKEN, DP)).rejects.toBeDefined();
    expect(on401).not.toHaveBeenCalled();
  });

  it("CONTRAST: an on-demand settings verb (notification-prefs PUT) DOES fire the handler on 401", async () => {
    const on401 = vi.fn();
    setOn401Handler(on401);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    );

    await expect(putNotificationPrefs(TOKEN, sample)).rejects.toBeDefined();
    expect(on401).toHaveBeenCalledTimes(1);
  });
});
