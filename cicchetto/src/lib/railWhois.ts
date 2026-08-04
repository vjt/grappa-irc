import { createSignal, untrack } from "solid-js";
import type { WhoisBundle } from "./api";
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
// Fetch policy (#606 scope 2, then #800):
//   * NOTHING in the rail asks on its own. #606 called `requestRailWhois` on
//     first select of a query window; #800 removed that call, because that one
//     extra command measurably delayed the operator's NEXT message by seconds
//     (the ircd-side mechanism is unconfirmed — the fake-lag reading below is
//     the leading hypothesis, not a measurement). The store now fills only
//     from the user's OWN `/whois` (`userTopic.ts` routes a `source: "user"`
//     bundle for the nick the rail is showing into here).
//   * `requestRailWhois` therefore has NO production caller today. It is kept
//     deliberately, not by oversight: it is the seam #782's explicit fetch
//     control attaches to, and its de-dupe rules below are the ones that
//     button will need. It is NOT to be wired to any automatic trigger.
//   * When it IS called: ONE WHOIS per nick. Once the nick is KNOWN it is
//     never asked about again — there is NO staleness refetch. An ask that
//     produced nothing (reply in flight, or a reply carrying no fields
//     because the peer is offline) stands for `RAIL_WHOIS_RETRY_MS`, which
//     de-dupes rapid re-asks and lets an offline peer resolve later.
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
    byNick()[slug]?.[normalizeNick(nick)]?.bundle ?? undefined;

  // Called on query select. A nick we already know short-circuits FOREVER
  // (no staleness rule); a nick we asked about within the retry window
  // short-circuits too, so fast A→B→A switching cannot stack. A WHOIS is
  // visible to the
  // person it names — a target carrying umode +y is told "<nick> is doing a
  // WHOIS on you" (bahamut src/s_user.c:2200) — so every avoided refetch is
  // noise a peer does not receive, not merely a command grappa does not send.
  const requestRailWhois = (slug: string, nick: string): void => {
    const key = normalizeNick(nick);
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
    const key = normalizeNick(target);
    put(slug, key, { at: Date.now(), bundle });
  };

  // #373 — a peer renamed: move its cached bundle old→new. This cache is a
  // nick-keyed store, so it belongs to the rename migration set (CLAUDE.md:
  // one that skips it strands its old-nick rows) alongside the scrollback,
  // the read cursor and the selection. Stranding it costs three ways: the
  // card blanks, `requestRailWhois` misses on the new nick and re-asks the
  // ircd (one more closely-spaced command on a connection whose next PRIVMSG
  // then waits behind it — measured at 8s), and that re-ask puts "<nick> is
  // doing a WHOIS on you" in front of a +y peer for the crime of renaming.
  // A rename is an identity MIGRATION, so the bundle describes the same
  // person — host, realname, channels all still hold — and it is relabelled
  // rather than refetched.
  //
  // ONLY an entry that KNOWS something migrates. An ask still in flight, or
  // one answered empty, has nothing to carry — and its reply keys on the OLD
  // nick (`userTopic` routes on the wire `target`), so moving the marker
  // would suppress the new nick's ask while the answer landed on the dead
  // key. Dropping it lets the new nick ask once, which is the right outcome:
  // nothing is known about this peer, so a rename has nothing to preserve.
  //
  // Merge rule mirrors `renameReadCursorChannel`: an entry already under the
  // new nick wins (it is the fresher observation of that identity).
  const renameRailWhois = (slug: string, oldNick: string, newNick: string): void => {
    const oldKey = normalizeNick(oldNick);
    const newKey = normalizeNick(newNick);
    if (oldKey === newKey) return;
    setByNick((prev) => {
      const net = prev[slug];
      if (net === undefined || !(oldKey in net)) return prev;
      const { [oldKey]: moved, ...rest } = net;
      if (moved?.bundle == null || !whoisBundleHasFields(moved.bundle) || newKey in rest) {
        return { ...prev, [slug]: rest };
      }
      const carried = moved.bundle;
      return {
        ...prev,
        [slug]: {
          ...rest,
          [newKey]: {
            at: moved.at,
            // 307 RPL_WHOISREGNICK is "identified for THIS nick", not for the
            // person, so it is the one bahamut field a rename invalidates:
            // carrying it would badge the renamed peer "registered" on no
            // evidence. A services `account` (330) is connection-scoped and
            // legitimately survives — on those networks the badge stays, and
            // rightly, because there the account IS the person.
            bundle: { ...carried, target: newNick, is_registered: false },
          },
        },
      };
    });
  };

  return { railWhoisFor, requestRailWhois, ingestRailWhois, renameRailWhois };
});

export const railWhoisFor = exports_.railWhoisFor;
export const requestRailWhois = exports_.requestRailWhois;
export const ingestRailWhois = exports_.ingestRailWhois;
export const renameRailWhois = exports_.renameRailWhois;
