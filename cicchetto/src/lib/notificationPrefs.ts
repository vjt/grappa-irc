// #868 — cic-side mirror of the subject's server notification preferences.
//
// Why this exists. The live notify path (`subscribe.ts`: the in-app beep and
// the optimistic `document.title` bump) used to decide on a bare
// `matchesWatchlist` call, reading no preference at all — so `channel_mentions:
// false` still beeped and `private_messages_all: false` still beeped, while the
// OS push (decided server-side in `Grappa.Push.Triggers`) correctly stayed
// silent. One preference, two answers. `pushTriggers.shouldNotify` was the
// mirror of the server predicate but had NO live caller, which is exactly what
// DESIGN_NOTES flagged on 2026-06-21: "cic has no global notification-prefs
// signal to feed the full shouldNotify at message-arrival". This is that
// signal.
//
// Same shape as `highlightList.ts` / `aliasList.ts`: the prefs live in server
// user_settings with NO broadcast, so the signal only ever holds what the last
// server round-trip returned and every writer feeds it the AUTHORITATIVE
// response, never a locally-composed value (CLAUDE.md window-state invariant
// family — cic never originates state).
//
// Identity-scoped: with no broadcast to self-heal it, a logout/account-switch
// would otherwise leave the previous account's prefs deciding the new
// account's beeps. The reset returns the signal to
// `DEFAULT_NOTIFICATION_PREFS`, which is byte-identical to the server's
// `UserSettings.default_notification_prefs/0` — so an un-hydrated client
// behaves like a subject who never touched their settings, rather than like a
// subject who muted everything.

import { createSignal } from "solid-js";
import { token } from "./auth";
import { identityScopedStore } from "./identityScopedStore";
import {
  DEFAULT_NOTIFICATION_PREFS,
  getNotificationPrefs,
  type NotificationPrefs,
} from "./userSettings";

const exports_ = identityScopedStore((onIdentityChange) => {
  const [notificationPrefs, setNotificationPrefs] = createSignal<NotificationPrefs>(
    DEFAULT_NOTIFICATION_PREFS,
  );

  // Logout / account switch — back to the server's own defaults.
  onIdentityChange(() => setNotificationPrefs(DEFAULT_NOTIFICATION_PREFS));

  // Adopt a prefs map the SERVER returned (a GET body or a PUT's normalized
  // echo). Not a setter for client-composed values: the settings drawer owns
  // the form state and hands over only what came back over the wire.
  const mirrorNotificationPrefs = (prefs: NotificationPrefs): void => {
    setNotificationPrefs(prefs);
  };

  // Fetch the current prefs and mirror them. Called on every user-topic
  // (re)join alongside the highlight-list and alias hydrates.
  const refreshNotificationPrefs = async (): Promise<NotificationPrefs> => {
    const t = token();
    if (t === null) throw new Error("no session");
    const prefs = await getNotificationPrefs(t);
    setNotificationPrefs(prefs);
    return prefs;
  };

  return { notificationPrefs, mirrorNotificationPrefs, refreshNotificationPrefs };
});

export const notificationPrefs = exports_.notificationPrefs;
export const mirrorNotificationPrefs = exports_.mirrorNotificationPrefs;
export const refreshNotificationPrefs = exports_.refreshNotificationPrefs;
