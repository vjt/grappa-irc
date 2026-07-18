// #247 — /notify presence watch: cic-side mirror of the server-owned
// watch list + live presence map, and the toast queue for genuine
// online/offline transitions.
//
// cic NEVER originates state here (CLAUDE.md window-state invariant
// family): the list mirrors the `notify_list` full-snapshot events
// (per-mutation broadcast + user-topic after-join push), the dots
// mirror `presence_snapshot` / `presence_changed`, and mutations go
// through the REST surface which the server broadcasts back.
//
// ## Key folding
//
// `presence_snapshot` keys and the server's presence map are
// rfc1459-folded (`Grappa.IRC.Identifier.canonical_nick/1`: A-Z plus
// `[ ] \ ~` → `{ } | ^`). `rfc1459Fold` reproduces that fold EXACTLY —
// it is a wire-key format mirror, NOT a nick-equality helper: general
// nick comparison stays on `nickEquals`/`normalizeNick` (ascii, by
// documented tradeoff). Presence lookups must use the server's fold or
// bracket-nick dots (`Foo[1]`) silently never light up.

import { createSignal } from "solid-js";
import type { NotifyEntry } from "./api";

export type PresenceState = "online" | "offline" | "unknown";

export type PresenceToast = {
  id: number;
  networkId: number;
  nick: string;
  presence: "online" | "offline";
  ts: string;
};

// Mirror of `Grappa.IRC.Identifier.canonical_nick/1` — the server-side
// rfc1459 fold used as the presence-map key format on the wire.
export const rfc1459Fold = (nick: string): string =>
  nick.toLowerCase().replace(/\[/g, "{").replace(/\]/g, "}").replace(/\\/g, "|").replace(/~/g, "^");

const [watchByNetwork, setWatchByNetwork] = createSignal<Record<number, NotifyEntry[]>>({});
const [presenceByNetwork, setPresenceByNetwork] = createSignal<
  Record<number, Record<string, PresenceState>>
>({});
const [toasts, setToasts] = createSignal<PresenceToast[]>([]);

export { presenceByNetwork, toasts as presenceToasts, watchByNetwork };

// How long a transition toast stays up. Non-intrusive: it self-expires;
// the Watched panel keeps the durable signal (the dot).
const TOAST_MS = 6_000;
let toastSeq = 0;
// Injectable for tests — window.setTimeout in production.
let scheduleExpiry: (fn: () => void, ms: number) => void = (fn, ms) => {
  setTimeout(fn, ms);
};

export function _setScheduleExpiryForTest(fn: typeof scheduleExpiry): void {
  scheduleExpiry = fn;
}

export function dismissToast(id: number): void {
  setToasts((ts) => ts.filter((t) => t.id !== id));
}

// `notify_list` full snapshot (per-mutation broadcast + after-join
// push). Simple setState — no delta tracking, same contract as
// query_windows_list. String map keys (JSON objects) coerce to the
// numeric network id; non-numeric keys are dropped.
export function setNotifyList(networks: Record<string, NotifyEntry[]>): void {
  const next: Record<number, NotifyEntry[]> = {};
  for (const [key, entries] of Object.entries(networks)) {
    const networkId = Number(key);
    if (!Number.isFinite(networkId) || !Array.isArray(entries)) continue;
    next[networkId] = entries;
  }
  setWatchByNetwork(next);
}

// `presence_snapshot` — authoritative per-network dot map on
// (re)attach. Keys arrive server-folded; stored verbatim.
export function applyPresenceSnapshot(
  networkId: number,
  nicks: Record<string, PresenceState>,
): void {
  setPresenceByNetwork((prev) => ({ ...prev, [networkId]: { ...nicks } }));
}

// `presence_changed` — one live report. Updates the dot map always;
// queues a toast ONLY for genuine transitions (`initial: false`) per
// the issue's baseline rule (arming a large list must not fire a
// notification storm).
export function applyPresenceChange(payload: {
  network_id: number;
  nick: string;
  presence: "online" | "offline";
  initial: boolean;
  ts: string;
}): void {
  const key = rfc1459Fold(payload.nick);

  setPresenceByNetwork((prev) => ({
    ...prev,
    [payload.network_id]: { ...(prev[payload.network_id] ?? {}), [key]: payload.presence },
  }));

  if (payload.initial) return;

  const id = ++toastSeq;
  setToasts((ts) => [
    ...ts,
    {
      id,
      networkId: payload.network_id,
      nick: payload.nick,
      presence: payload.presence,
      ts: payload.ts,
    },
  ]);
  scheduleExpiry(() => dismissToast(id), TOAST_MS);
}

// Dot state for a display-form nick (the Watched panel iterates the
// watch list, whose entries are display-cased).
export function presenceFor(networkId: number, nick: string): PresenceState {
  return presenceByNetwork()[networkId]?.[rfc1459Fold(nick)] ?? "unknown";
}

// Identity teardown (logout / account switch) — mirror of the other
// identity-scoped stores' reset shape.
export function resetNotifyWatch(): void {
  setWatchByNetwork({});
  setPresenceByNetwork({});
  setToasts([]);
}
