import type { ChannelKey } from "./channelKey";
import { identityScopedStore } from "./identityScopedStore";
import { asciiFold } from "./nickEquals";

// #591 — the /ping reply-correlation table (the cic twin of shottino's
// (network, nick, stamp) table; see DESIGN_NOTES 2026-08-01). When the operator
// runs `/ping <nick>`, compose sends a CTCP PING carrying a client timestamp
// token and registers a pending entry here. The reply arrives as a server-typed
// `:notice` with `meta.ctcp_verb == "PING"` + `meta.ctcp_args == <token>`
// (cic NEVER parses \x01 — the server SSOT `Grappa.IRC.CTCP.verb_args/1`
// classified it). subscribe.ts resolves the token back to the SOURCE window and
// synthesizes the round-trip line there (irssi behavior), consuming the reply.
//
// Time is passed in explicitly (`sentAtMs` at register, `nowMs` at resolve) so
// the RTT delta is a pure subtraction — no wall clock inside this module, which
// is what makes it testable per the spec.
//
// Ephemeral + identity-scoped: cleared on logout / token rotation, like
// `inviteAck`. A ping in flight across a logout is simply forgotten — the RTT
// is an immediate cue, not an audit record.
//
// #637 leak guard — the pending entry is one-shot but was cleared ONLY by a
// matching reply or an identity change. An UNMATCHED /ping (a service that
// never echoes CTCP PING, a typo'd nick, a reply lost to a netsplit) therefore
// left an inert entry behind until logout — an unbounded growth path. Each
// register sweeps entries older than the horizon below (see registerPing), so
// the table is bounded by the pings issued within the last PENDING_TTL_MS.
// A reply that arrives past the horizon simply isn't correlated (it renders in
// its normal $server routing) — a CTCP round-trip that slow is not worth an RTT.
//
// #719 — the same story for every OTHER CTCP verb. `/ctcp bob VERSION` echoed
// its question in the source window (#640) but its answer rendered in `$server`,
// because PING was the only verb anything registered for. The two halves of one
// round trip landed in two different places.
//
// The reply cannot be keyed on a token — only PING echoes one — so the generic
// table keys on the VERB the question asked, in a table of its OWN. One map with
// a three-part key would let the two collide: a PING token is opaque
// operator-supplied text and could BE a verb, so `/ping frank VERSION` and a
// VERSION reply from frank would fight over one entry.
//
// Everything else is deliberately identical to the ping table — the same
// identity-scoped store, the same TTL horizon, the same one-shot resolve, and a
// sweep that runs over BOTH maps from EITHER register (a session that only ever
// ran /ctcp would otherwise never sweep the ping side). What it does NOT return
// is an RTT: with no token there is nothing to time against, and a non-PING
// reply renders as the answer it is rather than as a round trip.
export const PENDING_TTL_MS = 60_000;

type Pending = {
  sourceKey: ChannelKey;
  sourceChannel: string;
  sentAtMs: number;
};

// Key on (network id, ASCII-folded nick, opaque token). The fold matches the
// server's CASEMAPPING=ascii nick fold (#525) so a reply from `Bob` claims a
// `/ping bob` entry; the token is opaque (never re-tokenized).
const pendingKey = (networkId: number, nick: string, token: string): string =>
  `${networkId}\x00${asciiFold(nick)}\x00${token}`;

// #719 — the verb-keyed twin. The nick folds the same way; the VERB folds to
// upper case because neither end owns the other's spelling — the question comes
// from a parser that upper-cases OR a menu literal, the answer carries whatever
// the peer chose to send.
const queryKey = (networkId: number, nick: string, verb: string): string =>
  `${networkId}\x00${asciiFold(nick)}\x00${verb.toUpperCase()}`;

const exports_ = identityScopedStore((onIdentityChange) => {
  const pending = new Map<string, Pending>();
  const pendingQueries = new Map<string, Pending>();
  onIdentityChange(() => {
    pending.clear();
    pendingQueries.clear();
  });

  // #637 leak guard — evict entries older than the TTL horizon before
  // inserting. The horizon is measured against the REGISTERING caller's
  // sentAtMs, keeping the module wall-clock-free (spec). Bounds the tables to
  // the queries issued within the last PENDING_TTL_MS, so a run of unmatched
  // probes can no longer accumulate until logout. Both maps are swept from
  // either door: the bound is "queries issued in the last TTL", whichever verb
  // they carried.
  const sweep = (sentAtMs: number): void => {
    const horizon = sentAtMs - PENDING_TTL_MS;
    for (const map of [pending, pendingQueries]) {
      for (const [key, entry] of map) {
        if (entry.sentAtMs <= horizon) map.delete(key);
      }
    }
  };

  const registerPing = (
    networkId: number,
    nick: string,
    token: string,
    sourceKey: ChannelKey,
    sourceChannel: string,
    sentAtMs: number,
  ): void => {
    sweep(sentAtMs);
    pending.set(pendingKey(networkId, nick, token), { sourceKey, sourceChannel, sentAtMs });
  };

  // #719 — register a non-PING CTCP query so its reply can be attributed back
  // to the window it was asked from.
  const registerCtcpQuery = (
    networkId: number,
    nick: string,
    verb: string,
    sourceKey: ChannelKey,
    sourceChannel: string,
    sentAtMs: number,
  ): void => {
    sweep(sentAtMs);
    pendingQueries.set(queryKey(networkId, nick, verb), { sourceKey, sourceChannel, sentAtMs });
  };

  // #719 — the source window for a reply that CLAIMS a pending query, deleting
  // it (one-shot). Null for a reply matching nothing, which is what keeps an
  // UNSOLICITED probe answer falling back to `$server`: losing it would hide
  // the fact that somebody answered a question we never asked. Takes no clock,
  // unlike its ping twin — there is no RTT to compute, and the TTL horizon is
  // enforced at register by the sweep, not here.
  const resolveCtcpReply = (
    networkId: number,
    nick: string,
    verb: string,
  ): { sourceKey: ChannelKey; sourceChannel: string } | null => {
    const key = queryKey(networkId, nick, verb);
    const entry = pendingQueries.get(key);
    if (entry === undefined) return null;
    pendingQueries.delete(key);
    return { sourceKey: entry.sourceKey, sourceChannel: entry.sourceChannel };
  };

  // Returns the source window + RTT for a reply that CLAIMS a pending entry,
  // deleting it (one-shot). Returns null for a reply that matches nothing —
  // the caller then leaves that notice to its normal routing, untouched.
  const resolvePing = (
    networkId: number,
    nick: string,
    token: string,
    nowMs: number,
  ): { sourceKey: ChannelKey; sourceChannel: string; rttMs: number } | null => {
    const resolve = (key: string, entry: Pending) => {
      pending.delete(key);
      return {
        sourceKey: entry.sourceKey,
        sourceChannel: entry.sourceChannel,
        rttMs: nowMs - entry.sentAtMs,
      };
    };

    // Exact token match first — a well-behaved peer (or shottino) echoes the
    // token VERBATIM, so this is the precise, disambiguating path.
    const exactKey = pendingKey(networkId, nick, token);
    const exact = pending.get(exactKey);
    if (exact !== undefined) return resolve(exactKey, exact);

    // #637 — TOKEN-LESS reply fallback. Azzurra services (NickServ) answer a
    // CTCP PING with a BARE `\x01PING\x01`, dropping the token entirely — so the
    // exact key never matches and `/ping <service>` never rendered its RTT
    // (while `/ping <human>` did, the same session). ONLY when the reply carries
    // no token: fall back to the most-recent pending ping to THIS (network,
    // nick). Still scoped to the same ASCII-folded nick, so a reply cannot claim
    // another window's entry (the token invariant holds for non-empty tokens: a
    // wrong-but-present token still misses). Most-recent-wins is the sole
    // ambiguity, and only when the same nick is pinged twice while in flight.
    if (token !== "") return null;
    const nickPrefix = `${networkId}\x00${asciiFold(nick)}\x00`;
    let bestKey: string | undefined;
    let best: Pending | undefined;
    for (const [key, entry] of pending) {
      if (!key.startsWith(nickPrefix)) continue;
      if (best === undefined || entry.sentAtMs > best.sentAtMs) {
        best = entry;
        bestKey = key;
      }
    }
    if (best === undefined || bestKey === undefined) return null;
    return resolve(bestKey, best);
  };

  return { registerPing, resolvePing, registerCtcpQuery, resolveCtcpReply };
});

export const registerPing = exports_.registerPing;
export const resolvePing = exports_.resolvePing;
export const registerCtcpQuery = exports_.registerCtcpQuery;
export const resolveCtcpReply = exports_.resolveCtcpReply;
