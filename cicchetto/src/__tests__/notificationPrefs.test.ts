import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setToken } from "../lib/auth";
import { channelKey } from "../lib/channelKey";
import {
  applyConversationMute,
  clearConversationMute,
  mirrorNotificationPrefs,
  notificationPrefs,
  refreshNotificationPrefs,
} from "../lib/notificationPrefs";
import { DEFAULT_NOTIFICATION_PREFS, type NotificationPrefs } from "../lib/userSettings";

// #868 — the notification-prefs store. `subscribe.ts` reads this signal on
// every inbound message to decide the in-app beep and the optimistic
// `document.title` bump, so three properties are load-bearing:
//
//   * the un-hydrated value is the SERVER's own default, not an empty map. A
//     client that has not hydrated yet must behave like a subject who never
//     configured anything — never like one who muted everything.
//   * refreshNotificationPrefs hydrates from GET. That is the mechanism the
//     user-topic-join hydration relies on, so a pref set on another device
//     reaches this device's beep after a reload.
//   * mirrorNotificationPrefs adopts a server response, so toggling a pref in
//     the settings drawer changes the beep immediately rather than at the next
//     rejoin.

const TOKEN = "notif-prefs-tok";

const MUTED_MENTIONS: NotificationPrefs = {
  ...DEFAULT_NOTIFICATION_PREFS,
  channel_mentions: false,
  private_messages_all: false,
};

beforeEach(() => {
  setToken(TOKEN);
  mirrorNotificationPrefs(DEFAULT_NOTIFICATION_PREFS);
});

afterEach(() => {
  vi.restoreAllMocks();
  setToken(null);
  mirrorNotificationPrefs(DEFAULT_NOTIFICATION_PREFS);
});

describe("notificationPrefs store — #868", () => {
  it("starts at the server defaults, so an un-hydrated client is not silently muted", async () => {
    // A FRESH module instance, not the file-scope one: `beforeEach` mirrors a
    // known map into the shared signal, which would make this test assert the
    // mirror rather than the initial value. Mutating the store's initial value
    // reddened nothing until this was re-imported per-test — the assertion was
    // covering the line without constraining it.
    vi.resetModules();
    const fresh = await import("../lib/notificationPrefs");

    expect(fresh.notificationPrefs()).toEqual(DEFAULT_NOTIFICATION_PREFS);
    // Pinned explicitly: these two are what make the un-hydrated state
    // deliver rather than swallow.
    expect(fresh.notificationPrefs().channel_mentions).toBe(true);
    expect(fresh.notificationPrefs().private_messages_all).toBe(true);
  });

  it("refreshNotificationPrefs hydrates the signal from GET (the rejoin-hydration path)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ notification_prefs: MUTED_MENTIONS }), { status: 200 }),
    );

    const prefs = await refreshNotificationPrefs();

    expect(prefs).toEqual(MUTED_MENTIONS);
    expect(notificationPrefs()).toEqual(MUTED_MENTIONS);
  });

  it("refreshNotificationPrefs sends the bearer to the prefs endpoint", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ notification_prefs: DEFAULT_NOTIFICATION_PREFS }), {
        status: 200,
      }),
    );

    await refreshNotificationPrefs();

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/me/settings/notification-prefs");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("a failed GET leaves the last known prefs in place rather than blanking them", async () => {
    mirrorNotificationPrefs(MUTED_MENTIONS);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("nope", { status: 500 }));

    await expect(refreshNotificationPrefs()).rejects.toBeDefined();

    // The user-topic hydrate swallows this rejection into a console.warn; the
    // signal must not have been clobbered on the way out.
    expect(notificationPrefs()).toEqual(MUTED_MENTIONS);
  });

  it("refreshNotificationPrefs without a session throws instead of fetching unauthenticated", async () => {
    setToken(null);
    const spy = vi.spyOn(globalThis, "fetch");

    await expect(refreshNotificationPrefs()).rejects.toThrow("no session");
    expect(spy).not.toHaveBeenCalled();
  });

  it("mirrorNotificationPrefs adopts a server response so a settings toggle takes effect at once", () => {
    mirrorNotificationPrefs(MUTED_MENTIONS);
    expect(notificationPrefs()).toEqual(MUTED_MENTIONS);
  });
});

// #866 Q3 — snooze expiry belongs to the READER, on both ports. The server
// drops elapsed entries inside `get_notification_prefs/1`; this signal is its
// client twin. It matters here and not only there because the mirror is
// refreshed on a user-topic (re)join and nothing else: a snooze set at 09:00
// for one hour must stop silencing at 10:00 in a tab that has been open the
// whole time, without a round-trip.
describe("notificationPrefs muted_targets expiry — #866", () => {
  const NOW_SECONDS = 1_800_000_000;

  // #1038 — expiry itself is key-shape-agnostic, but these keys are written
  // in the CURRENT grammar anyway. A file that half-speaks the old shape is
  // how the next reader learns the wrong one.
  const NOISY = channelKey("azzurra", "#noisy");
  const ALICE = channelKey("azzurra", "alice");

  const withMutes = (muted: NotificationPrefs["muted_targets"]): NotificationPrefs => ({
    ...DEFAULT_NOTIFICATION_PREFS,
    muted_targets: muted,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SECONDS * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a permanent mute (until: null)", () => {
    mirrorNotificationPrefs(withMutes({ [NOISY]: { until: null } }));

    expect(notificationPrefs().muted_targets).toEqual({ [NOISY]: { until: null } });
  });

  it("keeps a snooze whose until is still ahead", () => {
    mirrorNotificationPrefs(withMutes({ [NOISY]: { until: NOW_SECONDS + 60 } }));

    expect(notificationPrefs().muted_targets).toEqual({ [NOISY]: { until: NOW_SECONDS + 60 } });
  });

  it("drops a snooze whose until has elapsed, leaving the conversation audible again", () => {
    mirrorNotificationPrefs(withMutes({ [NOISY]: { until: NOW_SECONDS - 1 } }));

    expect(notificationPrefs().muted_targets).toEqual({});
  });

  it("expires at the READ, not at the mirror — the same stored map answers differently as the clock moves", () => {
    // The discriminating one. Nothing re-hydrates between the two reads, so a
    // filter applied in `mirrorNotificationPrefs` (or in the settings drawer)
    // would keep silencing `#noisy` forever and leave this red.
    mirrorNotificationPrefs(withMutes({ [NOISY]: { until: NOW_SECONDS + 60 } }));
    expect(notificationPrefs().muted_targets).toEqual({ [NOISY]: { until: NOW_SECONDS + 60 } });

    vi.setSystemTime((NOW_SECONDS + 61) * 1000);

    expect(notificationPrefs().muted_targets).toEqual({});
  });

  it("expires per entry — an elapsed snooze does not take a permanent mute with it", () => {
    mirrorNotificationPrefs(
      withMutes({ [NOISY]: { until: NOW_SECONDS - 1 }, [ALICE]: { until: null } }),
    );

    expect(notificationPrefs().muted_targets).toEqual({ [ALICE]: { until: null } });
  });

  it("tolerates a server that sends no muted_targets at all (cic ships ahead of the BEAM)", () => {
    const legacy = { ...DEFAULT_NOTIFICATION_PREFS };
    delete legacy.muted_targets;

    mirrorNotificationPrefs(legacy);

    expect(notificationPrefs().muted_targets).toBeUndefined();
    expect(notificationPrefs().channel_mentions).toBe(true);
  });
});

// #950 — the WRITE side of the mute, reached from outside the settings drawer
// (the rail picker). The drawer owns a hydrated form copy of the prefs; a rail
// tap has none, which is the whole reason this verb exists and why it reads the
// server before it writes.
describe("conversation mute writer — #950", () => {
  // #1038 — keys are the composite ChannelKey. Built through the production
  // `channelKey` rather than written as literals: the brand makes a bare name
  // a compile error, and these tests are about the WRITER, not the shape (the
  // shape is pinned in channelKey's own suite and in `IdentifierTest`).
  const NOISY = channelKey("azzurra", "#noisy");
  const ALREADY = channelKey("azzurra", "#already");

  const SERVER_STATE: NotificationPrefs = {
    ...DEFAULT_NOTIFICATION_PREFS,
    channel_mentions: false,
    channel_messages_only: ["#italia"],
    muted_targets: { [ALREADY]: { until: null } },
  };

  const mockGetThenPut = () => {
    const spy = vi.spyOn(globalThis, "fetch");
    spy.mockImplementation((_url, init) => {
      const method = (init as RequestInit | undefined)?.method ?? "GET";
      if (method === "GET") {
        return Promise.resolve(
          new Response(JSON.stringify({ notification_prefs: SERVER_STATE }), { status: 200 }),
        );
      }
      // The server echoes back what it normalized — the drawer and this writer
      // both adopt the ECHO, never the locally-composed body. The request body
      // is the bare prefs map; only the RESPONSE is wrapped.
      const sent = JSON.parse((init as RequestInit).body as string);
      return Promise.resolve(
        new Response(JSON.stringify({ notification_prefs: sent }), { status: 200 }),
      );
    });
    return spy;
  };

  const putBody = (spy: ReturnType<typeof mockGetThenPut>): NotificationPrefs => {
    const put = spy.mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === "PUT",
    );
    if (put === undefined) throw new Error("no PUT was issued");
    return JSON.parse((put[1] as RequestInit).body as string);
  };

  it("writes the chosen until as a positive integer under the folded key", async () => {
    const spy = mockGetThenPut();

    await applyConversationMute(NOISY, 1_800_000_600);

    expect(putBody(spy).muted_targets).toMatchObject({ [NOISY]: { until: 1_800_000_600 } });
  });

  it("keeps the mutes that were already there instead of replacing the map", async () => {
    const spy = mockGetThenPut();

    await applyConversationMute(NOISY, 1_800_000_600);

    expect(putBody(spy).muted_targets).toMatchObject({ [ALREADY]: { until: null } });
  });

  it("writes a permanent mute when the offer carries no expiry", async () => {
    const spy = mockGetThenPut();

    await applyConversationMute(NOISY, null);

    expect(putBody(spy).muted_targets).toMatchObject({ [NOISY]: { until: null } });
  });

  it("clearConversationMute drops just that key", async () => {
    const spy = mockGetThenPut();

    await clearConversationMute(ALREADY);

    const muted = putBody(spy).muted_targets ?? {};
    expect(Object.hasOwn(muted, ALREADY)).toBe(false);
  });

  // The discriminating one. The mirrored signal is DEFAULT until a user-topic
  // (re)join hydrates it, so a writer that PUT `notificationPrefs()` would ship
  // `channel_mentions: true` and an EMPTY whitelist over a subject who had
  // turned both off — silently undoing settings from a rail tap. Reading the
  // server first is what makes the write additive.
  it("PUTs the SERVER's prefs, never the un-hydrated mirror", async () => {
    mirrorNotificationPrefs(DEFAULT_NOTIFICATION_PREFS);
    const spy = mockGetThenPut();

    await applyConversationMute(NOISY, 1_800_000_600);

    const body = putBody(spy);
    expect(body.channel_mentions).toBe(false);
    expect(body.channel_messages_only).toEqual(["#italia"]);
  });

  it("adopts the server echo so the live beep path honours the new mute at once", async () => {
    mockGetThenPut();

    await applyConversationMute(NOISY, 1_800_000_600);

    expect(notificationPrefs().muted_targets).toMatchObject({ [NOISY]: { until: 1_800_000_600 } });
    expect(notificationPrefs().channel_mentions).toBe(false);
  });

  it("without a session it neither fetches nor pretends to have written", async () => {
    setToken(null);
    const spy = vi.spyOn(globalThis, "fetch");

    await expect(applyConversationMute(NOISY, 1_800_000_600)).rejects.toThrow("no session");
    expect(spy).not.toHaveBeenCalled();
  });

  it("propagates a failed write instead of reporting a mute that never landed", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));

    await expect(applyConversationMute(NOISY, 1_800_000_600)).rejects.toBeDefined();
  });
});
