import { createSignal, untrack } from "solid-js";
import type { WhoisBundle } from "./api";
import { casemappingForSlug } from "./casemapping";
import { identityScopedStore } from "./identityScopedStore";
import { networkIdBySlug } from "./networks";
import { normalizeNick } from "./nickEquals";
import { pushWhois } from "./socket";
import { whoisBundleHasFields } from "./whoisBundle";

// #606 — rail whois store: the per-nick WHOIS cache that backs the
// query-window rail context (the deferred half of #474). It is DELIBERATELY
// separate from the single-slot `whoisCard.ts` store:
//
//   * `whoisCard.ts` holds ONE bundle per network slug and is owned by the
//     user-issued `/whois` scrollback card (compose + UserContextMenu).
//   * this store holds one bundle PER NICK and is auto-populated when a
//     query window is selected — it must NOT clobber the single-slot store
//     (opening two queries would stomp the card) nor forge a scrollback
//     card the user never asked for.
//
// Fetch policy (#606 scope 2, then #800, settled by #782):
//   * The rail asks when the card is ON SCREEN showing a nick this store does
//     not have — `RailContext` calls `requestRailWhois` gated on its
//     `onScreen` prop. Nothing else may call it.
//   * The two rejected shapes, so neither comes back: #606 asked on SELECT,
//     which spent an upstream command filling a card the mobile operator
//     could not see (the rail is mounted-but-off-screen when the drawer is
//     shut) and measurably delayed the operator's NEXT message by seconds —
//     the ircd-side mechanism is still unconfirmed (#800; the fake-lag
//     reading below is the leading hypothesis, not a measurement), but the
//     rule does not rest on it: cic cannot see the connection's upstream cost
//     at all, so it must not spend it speculatively. #800 then removed the
//     ask outright, which is the opposite error — a card that can never fill.
//     Visibility is the line between the two: a card on screen is not a
//     speculation, it is a nick the operator is looking at right now.
//   * A user-driven control was considered and is NOT what shipped (#782 was
//     reshaped away from a button — vjt: "rail is on screen, cache is empty,
//     do a whois and when response comes display it"). Do not add one as well.
//   * ONE WHOIS per nick. Once the nick is KNOWN it is never asked about
//     again — there is NO staleness refetch, and re-opening the drawer over a
//     known nick therefore costs nothing. An ask that produced nothing (reply
//     in flight, or a reply carrying no fields because the peer is offline)
//     stands for `RAIL_WHOIS_RETRY_MS`, which de-dupes rapid re-asks and lets
//     an offline peer resolve later.
//   * The store also fills WITHOUT being asked, from the user's OWN `/whois`
//     (`userTopic.ts` routes a `source: "user"` bundle for the nick the rail
//     is showing into here) — a free refresh that then satisfies the de-dupe.
//
// The freshness TTL this store shipped with is deliberately GONE. The reading
// that follows is INFERRED FROM BAHAMUT SOURCE and has never been measured
// against a running ircd (#800) — it is the best lead for WHY an extra command
// delays the next one, not an established fact. What IS measured is the delay
// itself. It was not
// a cost problem: on bahamut a WHOIS and a PRIVMSG carry the same fake-lag
// flag and the same `since += 2 + len/120` (src/parse.c:236). The problem is
// the CEILING — `s_bsd.c:1657` gates the recvQ drain on
// `since - now < 10`, so after ~5 closely-spaced commands the ircd keeps
// reading grappa's socket but STOPS PARSING it: whatever the operator sends
// next sits in the ircd's receive queue until `since` drains. A TTL invites
// exactly that burst
// (cycle back through N query windows after a minute and every one refires),
// and the operator's next message pays for it. Not refetching removes the
// burst by construction instead of policing it — the cheapest rate limiter
// is the command you never send.
//
// There is a second, stronger reason, and it is not about cost at all: a
// WHOIS is VISIBLE TO THE PERSON IT NAMES. A target carrying umode +y is sent
// "<nick> is doing a WHOIS on you" (bahamut src/s_user.c:2200 — a
// `sendto_one` to the target, not an oper broadcast). Every automatic refetch
// is therefore noise delivered onto a peer for a refresh nobody requested.
// The rule this store is built against:
//
//     The rail NEVER sends a WHOIS on a timer or as a speculative prefetch.
//     It sends exactly ONE when it has to show a nick it does not have.
//
// "Show" is literal, and #782 is what made it literal: on screen, in front of
// the operator. A selected-but-hidden card is a prefetch and gets nothing.
//
// So the card is fetched once and is not refreshable; a long-lived rail shows
// a stale idle clock. The operator's own `/whois <peer>` still lands here
// (`userTopic` routes a `source: "user"` bundle for the shown nick into this
// cache) — that one the user asked for.
//
// Both stores are fed by the SAME `whois_bundle` user-topic event. The
// server marks each bundle's origin (`source: "user" | "rail"`, #606
// option 2) so `userTopic.ts` can route without ambiguity: the single-slot
// store takes only `"user"` bundles; this store takes `"rail"` bundles PLUS
// a `"user"` bundle for the nick the rail is currently showing (a free
// refresh — which turns the shared-`whois_pending` collision into a cache
// hit rather than a race). `requestRailWhois` therefore issues its WHOIS
// tagged `"rail"`; `ingestRailWhois` just caches by nick.

// How long an ASK stands before a re-select is allowed to ask again. It
// covers both ways an ask can fail to produce data — a reply still in flight,
// and a reply that arrived carrying nothing (the peer was offline, so bahamut
// answered 401 + 318 and the bundle is all-null) — because from the rail's
// side those are the same state: asked at `at`, still nothing to show. It is
// NOT a freshness clock: a bundle WITH fields is never re-asked.
const RAIL_WHOIS_RETRY_MS = 30_000;

type RailWhoisEntry = {
  /** Epoch ms of the ask (`requestRailWhois`) or of the reply (`ingest`). */
  at: number;
  bundle: WhoisBundle | null;
};

const exports_ = identityScopedStore((onIdentityChange) => {
  const [byNick, setByNick] = createSignal<Record<string, Record<string, RailWhoisEntry>>>({});

  onIdentityChange(() => setByNick({}));

  const put = (slug: string, key: string, entry: RailWhoisEntry): void => {
    setByNick((prev) => ({ ...prev, [slug]: { ...(prev[slug] ?? {}), [key]: entry } }));
  };

  // Reactive getter for the card — tracks `byNick` so the rail re-renders
  // when the bundle lands or is refreshed. Case-folded (#525) so `Alice`
  // and `alice` share one cache entry, matching the ircd + server fold.
  const railWhoisFor = (slug: string, nick: string): WhoisBundle | undefined =>
    byNick()[slug]?.[normalizeNick(nick, casemappingForSlug(slug))]?.bundle ?? undefined;

  // Called by `RailContext` when the query card comes ON SCREEN (#782), which
  // is the ONLY caller. A nick we already know short-circuits FOREVER (no
  // staleness rule), so re-opening the drawer over a known nick is free; a
  // nick we asked about within the retry window short-circuits too, so fast
  // A→B→A switching and open/close/open cannot stack. A WHOIS is visible to
  // the person it names — a target carrying umode +y is told "<nick> is doing
  // a WHOIS on you" (bahamut src/s_user.c:2200) — so every avoided refetch is
  // noise a peer does not receive, not merely a command grappa does not send.
  // (vjt has been told this twice and wants the on-screen fetch regardless;
  // it is the argument for never asking MORE than once, not for not asking.)
  const requestRailWhois = (slug: string, nick: string): void => {
    const key = normalizeNick(nick, casemappingForSlug(slug));
    const now = Date.now();
    const entry = untrack(() => byNick()[slug]?.[key]);
    if (entry) {
      // Answered — the nick is known, and known is forever.
      if (entry.bundle !== null && whoisBundleHasFields(entry.bundle)) return;
      // Asked recently, nothing to show for it yet (in flight, or answered
      // empty). One ask per retry window, so cycling windows cannot burst.
      if (now - entry.at < RAIL_WHOIS_RETRY_MS) return;
    }
    const networkId = networkIdBySlug(slug);
    if (networkId === undefined) return;
    // Keep any empty bundle visible (the card says "no WHOIS information
    // returned" rather than blinking out) while the retry is in flight.
    put(slug, key, { at: now, bundle: entry?.bundle ?? null });
    // Fire-and-forget: unlike the operator /whois (compose.ts awaits and
    // surfaces the reject inline), the rail auto-fetch was not user-initiated,
    // so a transient push reject (socket not connected, rate-limit) is
    // non-actionable and stays silent. The retry window covers it — a
    // re-select after RAIL_WHOIS_RETRY_MS asks again.
    void pushWhois(networkId, nick, null, "rail").catch(() => {});
  };

  // Feed the per-nick cache from an arriving `whois_bundle`. A bundle WITH
  // fields settles the nick for good; an empty one (401 + 318 for a nick
  // nobody holds) is stored so the card can say so, but re-stamps `at` so the
  // retry window governs when the rail may ask again. Origin routing is the
  // caller's job in `userTopic.ts`, off the server-marked `source`.
  const ingestRailWhois = (slug: string, target: string, bundle: WhoisBundle): void => {
    const key = normalizeNick(target, casemappingForSlug(slug));
    put(slug, key, { at: Date.now(), bundle });
  };

  // Issue 1365 — a peer renamed: COPY its cached bundle old→new. A rename no
  // longer moves the query window (the server writes nothing on a NICK), so
  // the renamed peer keeps its old window and opens a new one, and the card
  // can come on screen under EITHER nick. The bundle describes the same
  // person — host, realname, channels all still hold — so the new nick gets
  // a copy and the old window keeps its own. Either miss would cost a WHOIS
  // upstream (one more closely-spaced command on the connection, and "<nick>
  // is doing a WHOIS on you" in front of a +y peer); moving instead of
  // copying only trades the new nick's WHOIS for one on the old nick, which
  // nobody holds any more. This is a cache of server replies, not window
  // state: it originates nothing the server would contradict.
  //
  // ONLY an entry that KNOWS something is copied. An ask still in flight, or
  // one answered empty, has nothing to carry, and its reply keys on the OLD
  // nick (`userTopic` routes on the wire `target`). An entry already under
  // the new nick wins: it is the fresher observation of that identity.
  const copyRailWhois = (slug: string, oldNick: string, newNick: string): void => {
    const casemapping = casemappingForSlug(slug);
    const oldKey = normalizeNick(oldNick, casemapping);
    const newKey = normalizeNick(newNick, casemapping);
    if (oldKey === newKey) return;
    setByNick((prev) => {
      const net = prev[slug];
      const known = net?.[oldKey];
      if (net === undefined || known?.bundle == null || !whoisBundleHasFields(known.bundle)) {
        return prev;
      }
      if (newKey in net) return prev;
      return {
        ...prev,
        [slug]: {
          ...net,
          [newKey]: {
            at: known.at,
            // 307 RPL_WHOISREGNICK is "identified for THIS nick", not for the
            // person, so it is the one bahamut field a rename invalidates:
            // carrying it would badge the renamed peer "registered" on no
            // evidence. A services `account` (330) is connection-scoped and
            // legitimately survives.
            bundle: { ...known.bundle, target: newNick, is_registered: false },
          },
        },
      };
    });
  };

  return { railWhoisFor, requestRailWhois, ingestRailWhois, copyRailWhois };
});

export const railWhoisFor = exports_.railWhoisFor;
export const requestRailWhois = exports_.requestRailWhois;
export const ingestRailWhois = exports_.ingestRailWhois;
export const copyRailWhois = exports_.copyRailWhois;
