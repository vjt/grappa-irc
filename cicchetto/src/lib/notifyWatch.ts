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
// ASCII-folded (`Grappa.IRC.Identifier.canonical_nick/1`: A-Z ONLY,
// CASEMAPPING=ascii, #525 — `[ ] \ ~` left UNTOUCHED, so `foo[1]` and
// `foo{1}` are DISTINCT identities). Presence lookups fold via
// `asciiFold` — the SINGLE client nick fold, shared with
// `nickEquals`/`normalizeNick` (#364 S13 consolidated the two former
// client folds into one). Without the fold, a case-variant dot (`Foo[1]`
// vs `foo[1]`) silently never lights up; `asciiFold` beats a bare
// `toLowerCase`, which Unicode-over-folds non-ASCII (`CAFÉ`→`café`), not
// the brackets.

import { createSignal } from "solid-js";
import type { NotifyEntry } from "./api";
import { atKey, type ByKey, keysOf, withKey } from "./byKey";
import { identityScopedStore } from "./identityScopedStore";
import { asciiFold } from "./nickEquals";
import { createToastQueue } from "./toasts";

export type PresenceState = "online" | "offline" | "unknown";

// Discriminated on `kind`: a genuine online/offline transition, or an
// upstream watch-list rejection (`presence_error` — review 2026-07-19
// R2: routed here so the failure is VISIBLE in production, not just in
// the cic_diag ring buffer). Both are PRESENCE, which is why they share
// one queue — and why #775's update notice does not join them: see
// `toasts.ts`, whose factory now owns the ids, the expiry timer and the
// dismissal that used to be hand-rolled here.
export type PresenceToast =
  | {
      kind: "transition";
      networkId: number;
      nick: string;
      presence: "online" | "offline";
      ts: string;
    }
  | {
      kind: "error";
      networkId: number;
      detail: string;
    };

const exports_ = identityScopedStore((onIdentityChange) => {
  const [watchByNetwork, setWatchByNetwork] = createSignal<Record<number, NotifyEntry[]>>({});
  // Network id → folded nick → state. A watched nick is the user's to
  // choose, so the inner record is a `ByKey` (issue 2453).
  const [presenceByNetwork, setPresenceByNetwork] = createSignal<
    Record<number, ByKey<PresenceState>>
  >({});
  // Scoped WITH the watch list: presence is a property of the identity that
  // asked to watch those nicks, so an account switch must take the dots and
  // the toasts with it.
  const toastQueue = createToastQueue<PresenceToast>();

  // Identity teardown (logout / account switch) — mirror of the other
  // identity-scoped stores' reset shape.
  const resetNotifyWatch = (): void => {
    setWatchByNetwork({});
    setPresenceByNetwork({});
    toastQueue.clear();
  };

  onIdentityChange(resetNotifyWatch);

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
    setPresenceByNetwork((prev) => ({ ...prev, [networkId]: keysOf(nicks) }));
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
    const key = asciiFold(payload.nick);

    setPresenceByNetwork((prev) => ({
      ...prev,
      [payload.network_id]: withKey(prev[payload.network_id], key, payload.presence),
    }));

    if (payload.initial) return;

    toastQueue.queue({
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
    toastQueue.queue({ kind: "error", networkId: payload.network_id, detail: payload.detail });
  };

  // Dot state for a display-form nick (the Watched panel iterates the
  // watch list, whose entries are display-cased).
  const presenceFor = (networkId: number, nick: string): PresenceState => {
    return atKey(presenceByNetwork()[networkId], asciiFold(nick)) ?? "unknown";
  };

  return {
    watchByNetwork,
    presenceByNetwork,
    toasts: toastQueue.toasts,
    resetNotifyWatch,
    dismissToast: toastQueue.dismiss,
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
export const dismissPresenceToast = exports_.dismissToast;
export const setNotifyList = exports_.setNotifyList;
export const applyPresenceSnapshot = exports_.applyPresenceSnapshot;
export const applyPresenceChange = exports_.applyPresenceChange;
export const applyPresenceError = exports_.applyPresenceError;
export const presenceFor = exports_.presenceFor;
