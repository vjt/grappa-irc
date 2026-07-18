import { createRoot, createSignal } from "solid-js";

// #249 — per-network SUPPORTED user-mode (umode) store.
//
// Seeded by the `supported_umodes_changed` user-topic event (userTopic.ts),
// which the server emits from its 004 RPL_MYINFO parse — the AVAILABILITY set
// the server advertises (distinct from the `umode_changed` ACTIVE set the
// operator holds). The `/umode` modal (UmodeModal) drives its togglable
// letters from this set, exactly as #216's isupport CHANMODES drives the
// channel-mode modal — falling back to a static bahamut table when the server
// never advertised (a network that omits 004 umodes, or a parked/pre-snapshot
// session; see `availableUmodes`).
//
// Keyed by network id (umodes are per (subject, network), like isupport's
// per-network capability set — unlike channelTopic's per-channel modes).
// Module-singleton reactive signal, harmlessly overwritten on the next seed;
// a logout leaves stale entries the next login's cold-snapshot re-seeds.
//
// The set is a sorted list of single-letter strings.
// `supportedUmodesForNetwork/1` returns `[]` for an unseeded network, which
// `availableUmodes` reads as "no server set → use the static fallback".

const exports_ = createRoot(() => {
  const [supportedUmodesByNetwork, setSupportedUmodesByNetwork] = createSignal<
    Record<number, string[]>
  >({});

  const seedSupportedUmodes = (networkId: number, modes: string[]): void => {
    setSupportedUmodesByNetwork((prev) => ({ ...prev, [networkId]: modes }));
  };

  return { supportedUmodesByNetwork, seedSupportedUmodes };
});

export const supportedUmodesByNetwork = exports_.supportedUmodesByNetwork;
export const seedSupportedUmodes = exports_.seedSupportedUmodes;

/**
 * The server-advertised supported umode letters for a network, or `[]` when
 * the network hasn't advertised (no 004 parsed yet / no live session). An
 * empty result signals "no server set" to `availableUmodes`, which then falls
 * back to the static umode table.
 */
export function supportedUmodesForNetwork(networkId: number): string[] {
  return supportedUmodesByNetwork()[networkId] ?? [];
}
