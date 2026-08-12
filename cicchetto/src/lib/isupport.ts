import { createSignal } from "solid-js";
import { moduleRoot } from "./moduleRoot";

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

export type IsupportEntry = {
  chanmodes: {
    a: string[];
    b: string[];
    c: string[];
    d: string[];
  };
  prefix: Record<string, string>;
  // #1251 — the type-A (list) modes this network advertises AND the server
  // knows the reply numerics for, in 005 order. The BanlistModal's mode
  // switcher renders exactly this set: a letter the network advertises but
  // the server cannot query never appears, so cic can never ask for a list
  // whose reply would never arrive.
  listModesQueryable: string[];
  // #1108 — the target-independent per-frame body budget, from the same 005
  // (see `frameBudget.ts` for what cic may and may not derive from it).
  // `null` when the server published none: unlike the capability table, this
  // has no honest default, because it is LINELEN minus the #246 worst-case
  // relay reserve and a guess is just a wrong number to warn from.
  frameBudgetBase: number | null;
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
  listModesQueryable: ["b", "e", "I"],
  frameBudgetBase: null,
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
  frame_budget_base: number | null;
}): IsupportEntry {
  return {
    chanmodes: {
      a: payload.chanmodes_a,
      b: payload.chanmodes_b,
      c: payload.chanmodes_c,
      d: payload.chanmodes_d,
    },
    prefix: payload.prefix,
    listModesQueryable: payload.list_modes_queryable,
    frameBudgetBase: payload.frame_budget_base,
  };
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
