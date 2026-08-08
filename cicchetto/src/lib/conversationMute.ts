// #866 / #1018 / #1038 — the per-conversation mute LOOKUP: how a conversation
// is keyed into `NotificationPrefs.muted_targets`, and how membership is
// asked. Since #1038 the key is the composite `(network, target)` ChannelKey,
// so this module is a thin, well-named layer over `channelKey.ts` rather than
// a key derivation of its own — which is the point: the mute is now keyed
// like every other per-conversation store in the client.
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

import { type ChannelKey, channelKey } from "./channelKey";
import type { MutedTargets } from "./userSettings";

/**
 * The key under which a conversation is muted: the composite `ChannelKey` of
 * the NETWORK plus the thing an operator points at when they say "silence
 * this tab" — the channel for a channel, the PEER for a DM.
 *
 * Never the `channel` field of a DM row: an inbound DM carries
 * `channel = own_nick`, so keying on it collapses every DM onto ONE entry and
 * muting one peer silences them all. Callers pass the peer explicitly.
 *
 * `channelKey` folds the target through `canonicalChannel` (the mirror of
 * `Identifier.canonical_target/1`), which folds a nick exactly as it folds a
 * channel — a sigil sits outside `A-Z` — so one expression serves both
 * shapes.
 *
 * #1038 — the network IS in the key, reversing #866 Q5. That ruling made
 * `#grappa` ONE mute across every network on purpose; vjt withdrew it on
 * 2026-08-08 because muting `#linux` on one network silenced it on all of
 * them and nothing on screen could say which network a mute belonged to.
 * Reusing the existing `channelKey` brand rather than minting a second
 * composite shape is deliberate: the mute was the last per-conversation
 * store not keyed like `scrollback` / `selection` / `subscribe`, and two
 * notions of "which conversation" always drift apart. The server keys the
 * same string through `Grappa.IRC.Identifier.channel_key/2`.
 */
export function conversationMuteKey(networkSlug: string, target: string): ChannelKey {
  return channelKey(networkSlug, target);
}

/**
 * The mute key of a sidebar WINDOW (#1018). For a query window `channelName`
 * IS the peer nick — `activeWindows.windowCandidates` builds it from
 * `qw.targetNick` — which is exactly the identifier the DM notify path folds,
 * so ONE expression serves both kinds without ever touching a row's `channel`
 * field. Structurally typed rather than importing `ActiveWindow`, to keep the
 * mute lookup free of a dependency on the window projection — and since
 * #1038 the window's own `networkSlug` is part of that structure, because it
 * is part of the key.
 */
export function windowMuteKey(window: { networkSlug: string; channelName: string }): ChannelKey {
  return conversationMuteKey(window.networkSlug, window.channelName);
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
export function isConversationMuted(muted: MutedTargets | undefined, key: ChannelKey): boolean {
  return muted !== undefined && Object.hasOwn(muted, key);
}

/**
 * The map with `key` muted until `until` — unix SECONDS for a snooze (#950),
 * `null` for a permanent mute. Re-muting an already-muted conversation
 * REPLACES its expiry, which is what "snooze this again for 8 hours" means.
 *
 * The two writers (the drawer's picker and the rail's, #950) share this so the
 * stored shape is composed in ONE place: `undefined` (a BEAM with no mute
 * support yet) seeds an empty map rather than spreading into `undefined`.
 */
export function withConversationMute(
  muted: MutedTargets | undefined,
  key: ChannelKey,
  until: number | null,
): MutedTargets {
  return { ...(muted ?? {}), [key]: { until } };
}

/** The map without `key`. Absent key ⇒ unchanged map, never an error. */
export function withoutConversationMute(
  muted: MutedTargets | undefined,
  key: ChannelKey,
): MutedTargets {
  const next = { ...(muted ?? {}) };
  delete next[key];
  return next;
}
