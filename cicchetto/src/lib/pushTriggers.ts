// Foreground mirror of the server push predicate
// `Grappa.Push.Triggers.should_notify?/4` (PWA icon badge, 2026-06-21).
//
// Why a client-side copy exists. The badge's authoritative values come
// from the server (the `/me` seed, the `read_cursor_set` broadcast, and
// the push payload all carry a server-computed count). But the DESKTOP
// `document.title` must also move the instant a notify-worthy message
// arrives in an UNFOCUSED tab — before any read-cursor settle round-trips
// to the server. That single increment needs the same predicate the
// server uses, evaluated locally.
//
// One predicate, two ports. To stop this copy drifting from the Elixir
// original, BOTH run against ONE shared truth-table fixture
// (`shouldNotifyTruthTable.json`): the vitest `pushTriggers.test.ts` and
// the ExUnit `should_notify_parity_test.exs` consume the identical cases.
// Add a branch → add a row → both suites pick it up. Same discipline as
// the wireTypes parity gate.
//
// The mention sub-predicate is NOT reimplemented — it delegates to
// `matchesWatchlist` from `mentionMatch.ts`, the established mirror of
// `Grappa.Mentions.mentioned?/3` (own nick ∪ highlight patterns). #370 —
// the SAME predicate now drives the in-message visual highlight, so the
// notify-match and the visual-match can never diverge again.

import { type MessageKind, NOTIFY_KINDS } from "./api";
import { canonicalChannel } from "./channelKey";
import { matchesWatchlist } from "./mentionMatch";
import { asciiFold, nickEquals } from "./nickEquals";
import type { NotificationPrefs } from "./userSettings";

// Minimal structural shape the predicate needs — a subset of the wire
// scrollback message. Kept narrow so the truth-table JSON maps directly
// and call sites can pass any message-like object.
export type ShouldNotifyMessage = {
  kind: string;
  channel: string;
  sender: string;
  body: string | null;
};

/**
 * Returns true when `message` should produce a notification for the
 * operator whose IRC nick is `ownNick`, given `prefs` + `patterns`.
 *
 * Faithful transcription of `Grappa.Push.Triggers.should_notify?/4`:
 *   1. kind gate — only the shared `NOTIFY_KINDS` SSOT (privmsg|action,
 *      the "notify" subset of api's CONTENT_KINDS, #395) → everything else
 *      false. NOTICE (services chatter) counts as unread but never notifies.
 *   2. own row (#532 C) — a row this operator authored never notifies.
 *   3. muted conversation (#866) — the folded channel, or the folded PEER
 *      for a DM, present in `muted_targets`. Beats every reason below it,
 *      mentions included.
 *   4. DM (channel folds to ownNick): private_messages_all OR
 *      asciiFold(sender) in private_messages_only (mirrors the
 *      server's `canonical_target(sender) in ...`).
 *   5. channel: channel_messages_all OR canonicalChannel(channel) in
 *      channel_messages_only OR (channel_mentions AND mention).
 */
export function shouldNotify(
  message: ShouldNotifyMessage,
  ownNick: string,
  prefs: NotificationPrefs,
  patterns: string[],
): boolean {
  // `message.kind` is a bare string (the truth-table JSON / any message-like
  // object); cast to MessageKind for the typed-set membership check — a
  // non-member string just returns false. Same `.has(x as MessageKind)`
  // convention as `wireNarrow.ts`.
  if (!NOTIFY_KINDS.has(message.kind as MessageKind)) return false;

  // #532 C, #868 — "is this row mine?" decided by sender IDENTITY, and asked
  // BEFORE the window-shape test below. An OUTBOUND DM is persisted with
  // `channel = peer` (only an INBOUND one carries `channel = own_nick`), so
  // the shape test misroutes it to the channel branch, where the operator's
  // own highlight patterns run over the operator's own body — self-notifying
  // on every outgoing message that happens to contain their nick. The server
  // has had this step since #532 C (`triggers.ex` `own_row?/2`); this port
  // did not, and the shared fixture had no row that could see the gap.
  if (nickEquals(message.sender, ownNick)) return false;

  // Fold BOTH sides, mirroring the server's `dm?/2`. The `channel` KEY is
  // folded at the persist boundary (`Message.canonicalize_channel/1`, #537)
  // while `ownNick` is the RAW live nick off `net.nick` — so a raw `===`
  // silently fails for any operator whose nick carries an uppercase letter,
  // routing their inbound DMs into the channel branch. `canonicalChannel` is
  // the client mirror of `Identifier.canonical_target/1` and folds a
  // nick-shaped identifier exactly as it folds a channel (a sigil sits
  // outside `A-Z`), which is why the same function serves both sides here.
  const isDm = canonicalChannel(message.channel) === canonicalChannel(ownNick);

  // #866 — the per-conversation mute, and it wins over EVERY reason below,
  // including a direct mention (vjt's Q2: the mute always wins, because the
  // polite default for "I silenced this room" is that it stays silent).
  // That is why it sits here and not inside the two branches.
  if (isMuted(prefs, conversationKey(message, isDm))) return false;

  if (isDm) {
    return dmMatch(message, prefs);
  }
  return channelMatch(message, prefs, ownNick, patterns);
}

// The identity of the CONVERSATION the row belongs to — the thing an
// operator points at when they say "mute this tab". For a channel that is
// the channel; for a DM it is the PEER, never `message.channel`, which an
// inbound DM sets to own_nick (so keying on it would collapse every DM
// onto one mute). Same fold as the two whitelists: `canonicalChannel` is
// the mirror of `Identifier.canonical_target/1` and folds a nick exactly
// as it folds a channel.
function conversationKey(message: ShouldNotifyMessage, isDm: boolean): string {
  return canonicalChannel(isDm ? message.sender : message.channel);
}

// `until` is deliberately NOT read here. Expiry belongs to the READER
// (`notificationPrefs()` client-side, `get_notification_prefs/1` on the
// server) so this predicate stays pure and the shared truth-table needs no
// `now` column — vjt's Q3. A stored-but-elapsed mute reaching this point
// still silences; that only happens to a caller that bypassed the reader.
//
// `Object.hasOwn`, not `muted[key] !== undefined`: the map arrives from
// `JSON.parse`, so it carries Object.prototype and a peer legitimately
// nicked `constructor` or `toString` would otherwise read as muted.
function isMuted(prefs: NotificationPrefs, key: string): boolean {
  const muted = prefs.muted_targets;
  return muted !== undefined && Object.hasOwn(muted, key);
}

function dmMatch(message: ShouldNotifyMessage, prefs: NotificationPrefs): boolean {
  // ASCII fold on the sender, mirroring the server's
  // `Identifier.canonical_nick(sender) in private_messages_only` — the
  // whitelist entries are stored server-folded (CASEMAPPING=ascii, A-Z
  // only; #121/#525). A bare `.toLowerCase()` would Unicode-over-fold a
  // non-ASCII nick (`CAFÉ`→`café`), forking the key; neither fold touches
  // `[ ] \ ~`, so `foo[1]`/`foo{1}` stay DISTINCT the way the server keeps them.
  return (
    prefs.private_messages_all || prefs.private_messages_only.includes(asciiFold(message.sender))
  );
}

function channelMatch(
  message: ShouldNotifyMessage,
  prefs: NotificationPrefs,
  ownNick: string,
  patterns: string[],
): boolean {
  return (
    // canonicalChannel (the plain ASCII fold — #537 retired the sigil gate
    // on both ports), NOT a bare toLowerCase, mirroring the server's
    // `Identifier.canonical_target(channel) in
    // channel_messages_only` — the whitelist is stored channel-folded
    // (CASEMAPPING=ascii, A-Z only; #525). bahamut folds `A-Z` ONLY, so
    // `#Chan`/`#chan` are ONE channel but `#chan[1]` and `#chan{1}` are
    // DISTINCT (brackets untouched). A bare toLowerCase is avoided
    // because it Unicode-over-folds non-ASCII (`#CAFÉ`→`#café`), not the
    // brackets.
    prefs.channel_messages_all ||
    prefs.channel_messages_only.includes(canonicalChannel(message.channel)) ||
    (prefs.channel_mentions && matchesWatchlist(message.body, ownNick, patterns))
  );
}
