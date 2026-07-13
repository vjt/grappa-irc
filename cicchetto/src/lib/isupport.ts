import { createRoot, createSignal } from "solid-js";

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
};

const exports_ = createRoot(() => {
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
