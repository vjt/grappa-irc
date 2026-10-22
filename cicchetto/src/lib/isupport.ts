import { createSignal } from "solid-js";
import { DEFAULT_CHANTYPES } from "./chantypes";
import { moduleRoot } from "./moduleRoot";
import type { SessionISupportCasemapping } from "./wireTypes";

// #216 — per-network ISUPPORT channel-mode capability store.
//
// Seeded by the `isupport_changed` user-topic event (userTopic.ts),
// which the server emits from its 005 RPL_ISUPPORT CHANMODES= + PREFIX=
// parse (see `Grappa.Session.ISupport`). The `/mode` modal (ModeModal)
// drives its available toggle buttons from this table: which mode letters
// exist on this network, which are membership modes (→ a sigil), and
// which channel modes take a parameter.
//
// Keyed by network id (ISUPPORT is per-network, unlike channelTopic's
// per-channel modes cache). Module-singleton reactive signal — NOT
// identity-scoped: the capability set is a property of the network, not
// the bearer, and is harmlessly overwritten on the next seed. A logout
// leaves stale entries that the next login's cold-snapshot re-seeds.
//
// `DEFAULT_ISUPPORT` mirrors `Grappa.Session.ISupport.default/0` — the
// pre-005 bahamut/Azzurra values. `isupportForNetwork/1` returns it for
// any network not yet seeded, so the modal always has a usable table
// even before the WS snapshot lands (or for a parked session with no
// live isupport).

// #1255 — the fold the ircd applies to identifiers, as advertised by
// `CASEMAPPING=`. Pinned to the GENERATED wire contract, not hand-listed:
// `wireTypes.ts` is emitted from the Elixir typespec, so a server-side
// change to the modelled set lands here as a type error instead of a
// silently stale twin.
export type Casemapping = SessionISupportCasemapping;

export type IsupportEntry = {
  chanmodes: {
    a: string[];
    b: string[];
    c: string[];
    d: string[];
  };
  prefix: Record<string, string>;
  // #1302 — the PREFIX mode letters in the order the network ADVERTISED
  // them, highest rank first. The map above is a lookup table in both
  // directions and nothing else: it arrives as a JSON object whose key
  // order is the server runtime's (alphabetical by letter), so rank is
  // simply not recoverable from it — see `editorSigils`, which used to try.
  // Empty when the payload carried no order at all (a server predating the
  // field), which every reader must treat as "rank unknown", never as
  // "no levels".
  prefixOrder: string[];
  // #1251 — the type-A (list) modes this network advertises AND the server
  // knows the reply numerics for, in 005 order. The BanlistModal's mode
  // switcher renders exactly this set: a letter the network advertises but
  // the server cannot query never appears, so cic can never ask for a list
  // whose reply would never arrive.
  listModesQueryable: string[];
  // #1255 — the sigils that open a CHANNEL name on this network. Read via
  // `chantypesForNetwork` + `isChannelName` (see `chantypes.ts`, which owns
  // the fact and names the two copies that deliberately survive). Defaults
  // to the RFC 2812 class, so a network that omits the token behaves
  // exactly as the open-coded literals did.
  chantypes: string[];
  // #1255 — how the ircd folds identifiers. #1861 gave it a consumer:
  // `casemappingForNetwork` below feeds `normalizeNick`/`nickEquals`, so a
  // nick KEY now folds the way THIS network folds it instead of ASCII
  // everywhere. (The channel-key fold in `channelKey.ts` is still
  // ASCII-only — see the survivor list in `nickEquals.ts`.)
  casemapping: Casemapping;
  // #1255 — advertised cap per type-A (list) mode letter, e.g.
  // `{b: 100, e: 100, I: 100}`. Empty when the network advertised none:
  // there is no honest default cap, and #1251 made every advertised list
  // queryable from cic, so the cap now has a live consumer.
  maxlist: Record<string, number>;
  // #1255 — advertised length limits, `null` when unadvertised. Absent
  // means "validate nothing", which IS the pre-005 behaviour: a guessed
  // limit would start rejecting input the ircd accepts. Same posture as
  // `frameBudgetBase` below.
  nicklen: number | null;
  channellen: number | null;
  topiclen: number | null;
  // #1108 — the target-independent per-frame body budget, from the same 005
  // (see `frameBudget.ts` for what cic may and may not derive from it).
  // `null` when the server published none: unlike the capability table, this
  // has no honest default, because it is LINELEN minus the #246 worst-case
  // relay reserve and a guess is just a wrong number to warn from.
  frameBudgetBase: number | null;
  // issue 2430 — the network's own name, its 005 `NETWORK=` verbatim, `null`
  // when it advertised none. An order challenge names the network by it,
  // and cicchetto answers one only on an exact match (`e2e/orders.ts`), so
  // absent stays `null`: nothing to compare, nothing answered.
  network: string | null;
};

// Keep in lockstep with `Grappa.Session.ISupport.default/0` (server).
export const DEFAULT_ISUPPORT: IsupportEntry = {
  chanmodes: {
    a: ["I", "b", "e"],
    b: ["k"],
    c: ["l"],
    d: ["C", "D", "R", "c", "d", "i", "m", "n", "p", "r", "s", "t"],
  },
  prefix: { o: "@", h: "%", v: "+" },
  prefixOrder: ["o", "h", "v"],
  listModesQueryable: ["b", "e", "I"],
  chantypes: [...DEFAULT_CHANTYPES],
  casemapping: "ascii",
  maxlist: {},
  nicklen: null,
  channellen: null,
  topiclen: null,
  frameBudgetBase: null,
  network: null,
};

const exports_ = moduleRoot(() => {
  const [isupportByNetwork, setIsupportByNetwork] = createSignal<Record<number, IsupportEntry>>({});

  const seedIsupport = (networkId: number, entry: IsupportEntry): void => {
    setIsupportByNetwork((prev) => ({ ...prev, [networkId]: entry }));
  };

  return { isupportByNetwork, seedIsupport };
});

export const isupportByNetwork = exports_.isupportByNetwork;
export const seedIsupport = exports_.seedIsupport;

/**
 * The ISUPPORT capability table for a network, or the bahamut/Azzurra
 * default when the network hasn't been seeded yet (no live session /
 * pre-snapshot). Never returns undefined — the modal always has a table.
 */
export function isupportForNetwork(networkId: number): IsupportEntry {
  return isupportByNetwork()[networkId] ?? DEFAULT_ISUPPORT;
}

/**
 * Folds the flat `isupport_changed` wire shape into the nested store entry.
 *
 * Both doors go through here — the live 005 edge on the user topic and the
 * per-channel cold-snapshot — so a new 005 fact cannot reach one of them and
 * not the other, which is exactly how the two hand-copied literals this
 * replaced would have taken the #1108 budget.
 */
export function isupportEntryFromWire(payload: {
  chanmodes_a: string[];
  chanmodes_b: string[];
  chanmodes_c: string[];
  chanmodes_d: string[];
  list_modes_queryable: string[];
  prefix: Record<string, string>;
  prefix_order: string[];
  chantypes: string[];
  casemapping: Casemapping;
  maxlist: Record<string, number>;
  nicklen: number | null;
  channellen: number | null;
  topiclen: number | null;
  frame_budget_base: number | null;
  network: string | null;
}): IsupportEntry {
  return {
    chanmodes: {
      a: payload.chanmodes_a,
      b: payload.chanmodes_b,
      c: payload.chanmodes_c,
      d: payload.chanmodes_d,
    },
    prefix: payload.prefix,
    prefixOrder: payload.prefix_order,
    listModesQueryable: payload.list_modes_queryable,
    chantypes: payload.chantypes,
    casemapping: payload.casemapping,
    maxlist: payload.maxlist,
    nicklen: payload.nicklen,
    channellen: payload.channellen,
    topiclen: payload.topiclen,
    frameBudgetBase: payload.frame_budget_base,
    network: payload.network,
  };
}

/**
 * The channel sigils this network advertised (#1255), or the RFC 2812 class
 * for an unseeded network / a null id (no active network). Callers that ask
 * "is this token a channel name?" go through `isChannelName` instead.
 */
export function chantypesForNetwork(networkId: number | null): readonly string[] {
  if (networkId === null) return DEFAULT_CHANTYPES;
  return isupportForNetwork(networkId).chantypes;
}

/**
 * The membership letter→sigil map this network advertised (`PREFIX=`), or the
 * bahamut/Azzurra default for an unseeded network / a null id. Sibling of
 * `chantypesForNetwork` — a per-fact accessor so a caller that needs one 005
 * fact does not carry the whole entry around.
 *
 * Safe for sigil↔letter lookups in EITHER direction. NOT safe as an order:
 * the map crosses the wire alphabetical by mode letter (see `editorSigils`).
 */
export function prefixForNetwork(networkId: number | null): Record<string, string> {
  if (networkId === null) return DEFAULT_ISUPPORT.prefix;
  return isupportForNetwork(networkId).prefix;
}

/**
 * The membership SIGILS this network advertised, HIGHEST RANK FIRST —
 * `["~", "&", "@", "%", "+"]` on `PREFIX=(qaohv)~&@%+`. The client twin of
 * `Grappa.Session.ISupport.sigils/1`, and the ONE place a surface that
 * renders or orders a membership sigil may read the set from.
 *
 * issue 1999 — `memberSigil` and `tierRank` each carried their own `@ % +`
 * copy of this. Once the server stopped gluing sigils to nicks, a founder's
 * `["~"]` matched neither: drawn without a sigil, and sorted to the BOTTOM
 * of the members pane.
 *
 * Rank is `prefixOrder`'s, never the map's — `Object.values` comes back
 * alphabetical BY MODE LETTER, which on `(qaohv)` puts `o` in the MIDDLE
 * (the mis-rank #1302 found in `editorSigils`). An EMPTY order — a server
 * predating that field — falls back to the bahamut run rather than to `[]`:
 * `[]` would read as "this network has no membership levels" and silently
 * flatten every pane, which is strictly worse than assuming the run every
 * production network advertises anyway. A letter the map cannot resolve is
 * skipped rather than emitted as `undefined`.
 */
export function sigilRank(entry: IsupportEntry): string[] {
  const resolve = (e: IsupportEntry): string[] => {
    const out: string[] = [];
    for (const letter of e.prefixOrder) {
      const sigil = e.prefix[letter];
      if (sigil !== undefined) out.push(sigil);
    }
    return out;
  };

  const run = resolve(entry);
  return run.length > 0 ? run : resolve(DEFAULT_ISUPPORT);
}

/**
 * `sigilRank` for a network id, or the bahamut/Azzurra run for an unseeded
 * network / a null id. Sibling of `prefixForNetwork` — the per-fact
 * accessor, so a caller that needs the rank does not carry the whole entry.
 */
export function sigilRankForNetwork(networkId: number | null): string[] {
  if (networkId === null) return sigilRank(DEFAULT_ISUPPORT);
  return sigilRank(isupportForNetwork(networkId));
}

/**
 * How this network folds identifiers (#1861), or the bahamut/Azzurra
 * default `"ascii"` for an unseeded network / a null id. Sibling of
 * `chantypesForNetwork` — the store-reading half of the nick fold, whose
 * pure half is `normalizeNick`/`nickEquals` in `nickEquals.ts`.
 *
 * `"ascii"` is the honest default here, unlike `frameBudgetBaseForNetwork`'s
 * `null`: it is what `Grappa.Session.ISupport.default/0` uses pre-005, it
 * is what every production network advertises, and it is the NARROWER fold
 * — guessing it merges no identity the ircd keeps apart.
 */
export function casemappingForNetwork(networkId: number | null): Casemapping {
  if (networkId === null) return DEFAULT_ISUPPORT.casemapping;
  return isupportForNetwork(networkId).casemapping;
}

/**
 * The per-frame body budget base this network published (#1108), or `null`
 * when none has arrived — an unseeded network, a parked session, or a server
 * older than the field. Callers must treat `null` as "say nothing": the
 * budget reserves the #246 worst-case relayed prefix and is not cic's to
 * invent.
 */
export function frameBudgetBaseForNetwork(networkId: number | null): number | null {
  if (networkId === null) return null;
  return isupportForNetwork(networkId).frameBudgetBase;
}
