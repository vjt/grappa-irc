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
// `mentionsUser` from `mentionMatch.ts`, the established mirror of
// `Grappa.Mentions.mentioned?/3`.

import { mentionsUser } from "./mentionMatch";
import { rfc1459Fold } from "./nickEquals";
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

// Mirror of the Elixir kind gate: only PRIVMSG + ACTION (CTCP /me) carry
// a notification meaning. NOTICE (services chatter) and every presence /
// control kind never notify.
const NOTIFY_KINDS = new Set(["privmsg", "action"]);

/**
 * Returns true when `message` should produce a notification for the
 * operator whose IRC nick is `ownNick`, given `prefs` + `patterns`.
 *
 * Faithful transcription of `Grappa.Push.Triggers.should_notify?/4`:
 *   1. kind gate — non-(privmsg|action) → false.
 *   2. DM (channel === ownNick): private_messages_all OR
 *      rfc1459Fold(sender) in private_messages_only (mirrors the
 *      server's `canonical_nick(sender) in ...`).
 *   3. channel: channel_messages_all OR lower(channel) in
 *      channel_messages_only OR (channel_mentions AND mention).
 */
export function shouldNotify(
  message: ShouldNotifyMessage,
  ownNick: string,
  prefs: NotificationPrefs,
  patterns: string[],
): boolean {
  if (!NOTIFY_KINDS.has(message.kind)) return false;

  if (message.channel === ownNick) {
    return dmMatch(message, prefs);
  }
  return channelMatch(message, prefs, ownNick, patterns);
}

function dmMatch(message: ShouldNotifyMessage, prefs: NotificationPrefs): boolean {
  // rfc1459 fold on the sender, mirroring the server's
  // `Identifier.canonical_nick(sender) in private_messages_only` — the
  // whitelist entries are stored server-folded. A bare `.toLowerCase()`
  // here would miss a bracket-range nick the server folds.
  return (
    prefs.private_messages_all || prefs.private_messages_only.includes(rfc1459Fold(message.sender))
  );
}

function channelMatch(
  message: ShouldNotifyMessage,
  prefs: NotificationPrefs,
  ownNick: string,
  patterns: string[],
): boolean {
  return (
    prefs.channel_messages_all ||
    prefs.channel_messages_only.includes(message.channel.toLowerCase()) ||
    (prefs.channel_mentions && mentioned(message.body, ownNick, patterns))
  );
}

// Mirror of `Grappa.Mentions.mentioned?/3`: matches `ownNick` OR any
// `patterns` entry at a word boundary, case-insensitively. Empty terms
// are skipped by `mentionsUser` (falsy nick → false).
function mentioned(body: string | null, ownNick: string, patterns: string[]): boolean {
  return [ownNick, ...patterns].some((term) => mentionsUser(body, term));
}
