import { createRoot, createSignal } from "solid-js";

// #229 — per-network USER-mode (umode) store.
//
// Seeded by the `umode_changed` user-topic event (userTopic.ts), which the
// server emits from its 221 RPL_UMODEIS parse (the reply to the bare
// `MODE <selfnick>` query grappa issues at connect) and on every self-MODE
// echo. The `/mode <nick>` / `/umode` modal (UmodeModal) renders the KNOWN
// umode letters as toggles and marks which are active from this set.
//
// Keyed by network id (umodes are per (subject, network), like isupport's
// per-network capability set — unlike channelTopic's per-channel modes).
// Module-singleton reactive signal, harmlessly overwritten on the next seed;
// a logout leaves stale entries the next login's cold-snapshot re-seeds.
//
// The set is the operator's OWN umodes: a sorted list of single-letter
// strings (sign stripped — a umode is either set or not). `umodesForNetwork/1`
// returns `[]` for a network not yet seeded, so the modal always has a usable
// (empty) set even before the WS snapshot lands or for a parked session.

const exports_ = createRoot(() => {
  const [umodesByNetwork, setUmodesByNetwork] = createSignal<Record<number, string[]>>({});

  const seedUmodes = (networkId: number, modes: string[]): void => {
    setUmodesByNetwork((prev) => ({ ...prev, [networkId]: modes }));
  };

  return { umodesByNetwork, seedUmodes };
});

export const umodesByNetwork = exports_.umodesByNetwork;
export const seedUmodes = exports_.seedUmodes;

/**
 * The operator's own umode letters for a network, or `[]` when the network
 * hasn't been seeded yet (no live session / pre-snapshot). Never returns
 * undefined — the modal always has a set to render active-state against.
 */
export function umodesForNetwork(networkId: number): string[] {
  return umodesByNetwork()[networkId] ?? [];
}
