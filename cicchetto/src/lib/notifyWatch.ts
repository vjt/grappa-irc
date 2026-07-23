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
// ## Identity-scoped (#364 cicchetto S3)
//
// The store is built inside `identityScopedStore` so a logout / account
// switch clears the watch list + presence dots + toast queue, exactly like
// every sibling store (`awayStatus.ts`, `members.ts`, `mentions.ts`, …).
// Pre-fix `resetNotifyWatch` was dead production code (only the test called
// it), so switching accounts in the same browser leaked the previous
// identity's WatchedPanel rows and presence dots (network ids are global, so
// slugs collide across accounts) until the new `notify_list` snapshot landed.
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
import { identityScopedStore } from "./identityScopedStore";

export type PresenceState = "online" | "offline" | "unknown";

// Discriminated on `kind`: a genuine online/offline transition, or an
// upstream watch-list rejection (`presence_error` — review 2026-07-19
// R2: routed here so the failure is VISIBLE in production, not just in
// the cic_diag ring buffer). Both share the queue, expiry, and
// dismissal mechanics.
export type PresenceToast =
  | {
      id: number;
      kind: "transition";
      networkId: number;
      nick: string;
      presence: "online" | "offline";
      ts: string;
    }
  | {
      id: number;
      kind: "error";
      networkId: number;
      detail: string;
    };

// Mirror of `Grappa.IRC.Identifier.canonical_nick/1` — the server-side
// rfc1459 fold used as the presence-map key format on the wire.
//
// ASCII-byte-level by design (#364 cicchetto S4): the server folds
// bytes `A-Z` only (SQLite `lower()` + the four bracket replaces), NOT
// Unicode. `String.prototype.toLowerCase()` is Unicode-aware
// (`É`→`é`, `İ`→`i̇`) and would over-fold non-ASCII nicks the server
// keeps distinct — silently lighting the wrong presence row. Fold the
// `A-Z` range by char code so multibyte sequences pass through
// untouched, byte-for-byte with `fold_nick_byte/1`.
export const rfc1459Fold = (nick: string): string =>
  nick
    .replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32))
    .replace(/\[/g, "{")
    .replace(/\]/g, "}")
    .replace(/\\/g, "|")
    .replace(/~/g, "^");

// How long a transition toast stays up. Non-intrusive: it self-expires;
// the Watched panel keeps the durable signal (the dot).
const TOAST_MS = 6_000;
let toastSeq = 0;
// Injectable for tests — window.setTimeout in production. Module-level (not
// identity-scoped): a scheduler override must survive an account switch.
let scheduleExpiry: (fn: () => void, ms: number) => void = (fn, ms) => {
  setTimeout(fn, ms);
};

export function _setScheduleExpiryForTest(fn: typeof scheduleExpiry): void {
  scheduleExpiry = fn;
}

// Omit must distribute over the union arm-by-arm (a bare
// Omit<PresenceToast, "id"> would collapse the discriminant).
type ToastInput =
  | Omit<Extract<PresenceToast, { kind: "transition" }>, "id">
  | Omit<Extract<PresenceToast, { kind: "error" }>, "id">;

const exports_ = identityScopedStore((onIdentityChange) => {
  const [watchByNetwork, setWatchByNetwork] = createSignal<Record<number, NotifyEntry[]>>({});
  const [presenceByNetwork, setPresenceByNetwork] = createSignal<
    Record<number, Record<string, PresenceState>>
  >({});
  const [toasts, setToasts] = createSignal<PresenceToast[]>([]);

  // Identity teardown (logout / account switch) — mirror of the other
  // identity-scoped stores' reset shape.
  const resetNotifyWatch = (): void => {
    setWatchByNetwork({});
    setPresenceByNetwork({});
    setToasts([]);
  };

  onIdentityChange(resetNotifyWatch);

  const dismissToast = (id: number): void => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
  };

  function queueToast(toast: ToastInput): void {
    const id = ++toastSeq;
    setToasts((ts) => [...ts, { ...toast, id }]);
    scheduleExpiry(() => dismissToast(id), TOAST_MS);
  }

  // `notify_list` full snapshot (per-mutation broadcast + after-join
  // push). Simple setState — no delta tracking, same contract as
  // query_windows_list. String map keys (JSON objects) coerce to the
  // numeric network id; non-numeric keys are dropped.
  const setNotifyList = (networks: Record<string, NotifyEntry[]>): void => {
    const next: Record<number, NotifyEntry[]> = {};
    for (const [key, entries] of Object.entries(networks)) {
      const networkId = Number(key);
      if (!Number.isFinite(networkId) || !Array.isArray(entries)) continue;
      next[networkId] = entries;
    }
    setWatchByNetwork(next);
  };

  // `presence_snapshot` — authoritative per-network dot map on
  // (re)attach. Keys arrive server-folded; stored verbatim.
  const applyPresenceSnapshot = (networkId: number, nicks: Record<string, PresenceState>): void => {
    setPresenceByNetwork((prev) => ({ ...prev, [networkId]: { ...nicks } }));
  };

  // `presence_changed` — one live report. Updates the dot map always;
  // queues a toast ONLY for genuine transitions (`initial: false`) per
  // the issue's baseline rule (arming a large list must not fire a
  // notification storm).
  const applyPresenceChange = (payload: {
    network_id: number;
    nick: string;
    presence: "online" | "offline";
    initial: boolean;
    ts: string;
  }): void => {
    const key = rfc1459Fold(payload.nick);

    setPresenceByNetwork((prev) => ({
      ...prev,
      [payload.network_id]: { ...(prev[payload.network_id] ?? {}), [key]: payload.presence },
    }));

    if (payload.initial) return;

    queueToast({
      kind: "transition",
      networkId: payload.network_id,
      nick: payload.nick,
      presence: payload.presence,
      ts: payload.ts,
    });
  };

  // `presence_error` — the upstream rejected the watch registration
  // (ERR_MONLISTFULL 734 / ERR_TOOMANYWATCH 512). Queued as an
  // error-styled toast so the half-success (DB row created, upstream
  // registration refused) is never production-invisible; the raw
  // numeric also lands as a $server notice row server-side.
  const applyPresenceError = (payload: { network_id: number; detail: string }): void => {
    queueToast({ kind: "error", networkId: payload.network_id, detail: payload.detail });
  };

  // Dot state for a display-form nick (the Watched panel iterates the
  // watch list, whose entries are display-cased).
  const presenceFor = (networkId: number, nick: string): PresenceState => {
    return presenceByNetwork()[networkId]?.[rfc1459Fold(nick)] ?? "unknown";
  };

  return {
    watchByNetwork,
    presenceByNetwork,
    toasts,
    resetNotifyWatch,
    dismissToast,
    setNotifyList,
    applyPresenceSnapshot,
    applyPresenceChange,
    applyPresenceError,
    presenceFor,
  };
});

export const watchByNetwork = exports_.watchByNetwork;
export const presenceByNetwork = exports_.presenceByNetwork;
export const presenceToasts = exports_.toasts;
export const resetNotifyWatch = exports_.resetNotifyWatch;
export const dismissToast = exports_.dismissToast;
export const setNotifyList = exports_.setNotifyList;
export const applyPresenceSnapshot = exports_.applyPresenceSnapshot;
export const applyPresenceChange = exports_.applyPresenceChange;
export const applyPresenceError = exports_.applyPresenceError;
export const presenceFor = exports_.presenceFor;
