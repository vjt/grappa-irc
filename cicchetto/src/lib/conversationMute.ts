// #866 / #1018 — the per-conversation mute LOOKUP: how a conversation is
// keyed into `NotificationPrefs.muted_targets`, and how membership is asked.
//
// Extracted here (from `pushTriggers.ts`, its first and until #1018 only
// consumer) because three call sites now need the identical answer and a
// second hand-rolled derivation is exactly how the DM case rots:
//
//   * `pushTriggers.shouldNotify`  — should this arriving row notify?
//   * `activeWindows.orderUnreadWindows` — is this window a stop on the
//     Alt+A / Ctrl+N-P / affordance cycle? (#1018)
//   * `SettingsDrawer.muteCandidates` — which conversations does the picker
//     offer, and which are already muted?
//
// Expiry is deliberately absent: the READER resolves it
// (`notificationPrefs()` → `withLiveMutes` client-side,
// `UserSettings.get_notification_prefs/1` server-side), so nothing here
// needs a `now` and the push truth-table needs no clock column (#866 Q3).

import { canonicalChannel } from "./channelKey";
import type { MutedTargets } from "./userSettings";

/**
 * The key under which a conversation is muted: the FOLDED identifier of the
 * thing an operator points at when they say "silence this tab" — the channel
 * for a channel, the PEER for a DM.
 *
 * Never the `channel` field of a DM row: an inbound DM carries
 * `channel = own_nick`, so keying on it collapses every DM onto ONE entry and
 * muting one peer silences them all. Callers pass the peer explicitly.
 *
 * `canonicalChannel` (the mirror of `Identifier.canonical_target/1`) folds a
 * nick exactly as it folds a channel — a sigil sits outside `A-Z` — which is
 * why one fold serves both shapes. Per-subject and network-agnostic by
 * design: `#grappa` on two networks is ONE mute (#866 Q5).
 */
export function conversationMuteKey(target: string): string {
  return canonicalChannel(target);
}

/**
 * The mute key of a sidebar WINDOW (#1018). For a query window `channelName`
 * IS the peer nick — `activeWindows.windowCandidates` builds it from
 * `qw.targetNick` — which is exactly the identifier the DM notify path folds,
 * so ONE expression serves both kinds without ever touching a row's `channel`
 * field. Structurally typed rather than importing `ActiveWindow`, to keep the
 * mute lookup free of a dependency on the window projection.
 */
export function windowMuteKey(window: { channelName: string }): string {
  return conversationMuteKey(window.channelName);
}

/**
 * Is `key` (already folded via `conversationMuteKey`) muted?
 *
 * `Object.hasOwn`, not `muted[key] !== undefined`: the map arrives from
 * `JSON.parse`, so it carries Object.prototype and a peer legitimately nicked
 * `constructor` or `toString` would otherwise read as muted.
 *
 * `undefined` (a BEAM older than this bundle, #618) means "no mutes", never
 * "everything muted" — the tolerant direction.
 */
export function isConversationMuted(muted: MutedTargets | undefined, key: string): boolean {
  return muted !== undefined && Object.hasOwn(muted, key);
}
