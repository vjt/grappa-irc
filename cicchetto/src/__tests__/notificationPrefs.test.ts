import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setToken } from "../lib/auth";
import {
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
    mirrorNotificationPrefs(withMutes({ "#noisy": { until: null } }));

    expect(notificationPrefs().muted_targets).toEqual({ "#noisy": { until: null } });
  });

  it("keeps a snooze whose until is still ahead", () => {
    mirrorNotificationPrefs(withMutes({ "#noisy": { until: NOW_SECONDS + 60 } }));

    expect(notificationPrefs().muted_targets).toEqual({ "#noisy": { until: NOW_SECONDS + 60 } });
  });

  it("drops a snooze whose until has elapsed, leaving the conversation audible again", () => {
    mirrorNotificationPrefs(withMutes({ "#noisy": { until: NOW_SECONDS - 1 } }));

    expect(notificationPrefs().muted_targets).toEqual({});
  });

  it("expires at the READ, not at the mirror — the same stored map answers differently as the clock moves", () => {
    // The discriminating one. Nothing re-hydrates between the two reads, so a
    // filter applied in `mirrorNotificationPrefs` (or in the settings drawer)
    // would keep silencing `#noisy` forever and leave this red.
    mirrorNotificationPrefs(withMutes({ "#noisy": { until: NOW_SECONDS + 60 } }));
    expect(notificationPrefs().muted_targets).toEqual({ "#noisy": { until: NOW_SECONDS + 60 } });

    vi.setSystemTime((NOW_SECONDS + 61) * 1000);

    expect(notificationPrefs().muted_targets).toEqual({});
  });

  it("expires per entry — an elapsed snooze does not take a permanent mute with it", () => {
    mirrorNotificationPrefs(
      withMutes({ "#noisy": { until: NOW_SECONDS - 1 }, alice: { until: null } }),
    );

    expect(notificationPrefs().muted_targets).toEqual({ alice: { until: null } });
  });

  it("tolerates a server that sends no muted_targets at all (cic ships ahead of the BEAM)", () => {
    const legacy = { ...DEFAULT_NOTIFICATION_PREFS };
    delete legacy.muted_targets;

    mirrorNotificationPrefs(legacy);

    expect(notificationPrefs().muted_targets).toBeUndefined();
    expect(notificationPrefs().channel_mentions).toBe(true);
  });
});
