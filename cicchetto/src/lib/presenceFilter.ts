import { createRoot, createSignal } from "solid-js";
import type { ScrollbackMessage } from "./api";
import type { ChannelKey } from "./channelKey";

// #222 — hide join/part/quit/nick-change signalling on large channels by
// default, with a per-channel opt-in to re-show. Closed-set per-channel
// preference with localStorage persistence, backed by a module-singleton
// Solid signal so every open scrollback pane re-filters the moment the
// operator toggles the per-channel control.
//
// ## The whole feature in one sentence
//
// grappa STILL delivers join/part/quit/nick_change over the wire (no wire
// change, no server change); cic decides whether to RENDER them. The render
// decision is: on a "large" channel these four kinds are pure noise, so hide
// them by default — but let the operator pin a per-channel choice that WINS
// over the size default.
//
// ## Why a render-layer filter, not a store drop
//
// Suppression is purely visual. The message store (`scrollback.ts`) stays
// intact so unread-counting, the read-cursor divider, and own-JOIN
// auto-focus (all of which read `messages()`, not the rendered rows) keep
// working. ScrollbackPane's `rows()` memo is the filter site.
//
// ## Why closed-set keys, not a boolean-per-channel
//
// A boolean can't express "no explicit choice — follow the size default".
// The precedence rule the issue flagged as "going to be tough" needs a
// TRI-STATE: "show" | "hide" | unset (key absent). Explicit choice wins;
// unset follows the live member-count default. A bare boolean would collapse
// unset into one of the two poles and lose the auto-hide-on-growth behaviour.
// Closed-set union per CLAUDE.md ("atoms/literals, never untyped strings").
//
// ## Why a signal (mirror of timeFormat.ts)
//
// The pref is consumed at render time by ScrollbackPane's `rows()` memo. A
// bare `localStorage.getItem` there would NOT re-run when the toggle flips.
// Backing the per-channel map with a signal (createRoot, module-singleton)
// makes `channelPresenceVisible` reactive: reading it inside the memo tracks
// the signal, so toggling live re-filters the pane.
//
// localStorage only — per feedback_no_localized_strings_server_side, cic owns
// UI/display preferences client-side; no server-side persistence, no wire
// change (mirrors #217 timeFormat exactly).

// "large" cutoff. Named constant, one-line tune. 50+ member channels drown
// in J/P/Q; smaller channels keep them visible. A channel whose live member
// count crosses this while the pref is unset auto-flips.
export const LARGE_CHANNEL_THRESHOLD = 50;

// The NARROW noise set — join/part/quit/nick_change ONLY. Deliberately NOT
// ScrollbackPane's `PRESENCE_KINDS` (which also holds mode/topic/kick/
// server_event): those are NOT noise and MUST stay visible. Suppressing them
// would be a bug.
export const SUPPRESSED_PRESENCE_KINDS: ReadonlySet<ScrollbackMessage["kind"]> = new Set([
  "join",
  "part",
  "quit",
  "nick_change",
]);

// unset (key absent) = follow the size default.
export type PresencePref = "show" | "hide";

const STORAGE_KEY = "cicchetto.presenceFilter";

type PrefMap = Record<ChannelKey, PresencePref>;

function isPresencePref(v: unknown): v is PresencePref {
  return v === "show" || v === "hide";
}

// Read the persisted per-channel map, dropping any corrupt / unknown entries
// so one bad key can't poison the whole store. A parse failure (corrupt JSON)
// yields the empty map — every channel then follows the size default.
function readStored(): PrefMap {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return {};
    const out: PrefMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (isPresencePref(v)) out[k as ChannelKey] = v;
    }
    return out;
  } catch {
    return {};
  }
}

// Module-singleton signal seeded from storage. createRoot anchors it for the
// app lifetime (same shape as timeFormat.ts) — the preference is identity-
// agnostic display state, so no token-rotation reset arm is needed.
const { prefs, setPrefs } = createRoot(() => {
  const [prefs, setPrefs] = createSignal<PrefMap>(readStored());
  return { prefs, setPrefs };
});

function persist(map: PrefMap): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

// Non-reactive read for the pure precedence table + tests. Callers in a
// reactive render path use `channelPresenceVisible` so rows() re-filters.
export function getChannelPresencePref(key: ChannelKey): PresencePref | undefined {
  return prefs()[key];
}

export function setChannelPresencePref(key: ChannelKey, pref: PresencePref): void {
  setPrefs((prev) => {
    const next = { ...prev, [key]: pref };
    persist(next);
    return next;
  });
}

// Back to follow-the-size-default: remove the explicit pin entirely. This is
// the tri-state's API-completing "return to unset" operation (set/get/clear
// over the three states show/hide/unset). No UI affordance wires it today —
// the toggle is binary show↔hide per the #222 spec — but it is unit-tested and
// is the reset seam the ScrollbackPane wiring test uses between cases (same
// role as `clearReadCursors` / `seedFromTest` elsewhere). Kept deliberately so
// a future "reset to auto" affordance has a first-class verb instead of
// reaching into localStorage.
export function clearChannelPresencePref(key: ChannelKey): void {
  setPrefs((prev) => {
    if (!(key in prev)) return prev;
    const next = { ...prev };
    delete next[key];
    persist(next);
    return next;
  });
}

// THE PRECEDENCE RULE (the "tough" part). Pure + testable without the signal
// (mirror of timeFormat.ts's `renderTimestamp` vs `formatTimestamp`). An
// explicit choice WINS over the size default; unset follows the live count.
export function resolvePresenceVisible(
  pref: PresencePref | undefined,
  memberCount: number,
): boolean {
  if (pref === "show") return true; // explicit override wins
  if (pref === "hide") return false; // explicit override wins
  return memberCount < LARGE_CHANNEL_THRESHOLD; // unset → follow size default
}

// Reactive wrapper: reading `prefs()` inside a SolidJS render tracks the
// signal, so ScrollbackPane's rows() memo re-filters live when the toggle
// flips. Pass the CURRENT member count (from `membersByChannel()`) so it also
// re-runs when membership crosses the threshold.
export function channelPresenceVisible(key: ChannelKey, memberCount: number): boolean {
  return resolvePresenceVisible(prefs()[key], memberCount);
}

// #239 — the SINGLE "is this row visible under the channel's presence filter?"
// predicate. BOTH the render filter (ScrollbackPane's `rows()` memo) AND the
// unread-count derivation (selection.ts `perChannelUnread`) route through it,
// so a hidden control row can never inflate a badge the operator cannot clear
// (the count and the pane must agree on which rows "count" — CLAUDE.md "one
// feature, one code path"). A row is visible unless the channel is suppressing
// presence AND the row is one of the NARROW noise kinds. Reads the reactive
// pref signal (via `channelPresenceVisible`) ONLY for a suppressed kind, so the
// consumer memo/effect re-runs on toggle / membership-threshold changes exactly
// when a suppressed row is present. Never fold a second copy of this rule.
export function presenceRowVisible(
  key: ChannelKey,
  memberCount: number,
  kind: ScrollbackMessage["kind"],
): boolean {
  if (!SUPPRESSED_PRESENCE_KINDS.has(kind)) return true;
  return channelPresenceVisible(key, memberCount);
}

// #239 — the read-cursor advance target that skips the TRAILING run of hidden
// control messages on window display, WITHOUT marking any VISIBLE unread read.
// The presence filter hides join/part/quit/nick_change; the DOM-geometry settle
// paths (scroll / leave / blur) only ever reach the last RENDERED row, so a
// trailing run of hidden control messages past the cursor never gets a settle
// event and `last_read_message_id` stays stuck below them — the stuck badge.
//
// Order-INDEPENDENT: works on `msgs` in any order (the store sorts by
// [server_time asc, id asc], NOT by id — a delayed/batched or clock-skewed row
// can carry an earlier server_time yet a higher id, so array order can diverge
// from id order). We reason purely in id space: the target is the highest
// HIDDEN unread id that is strictly BELOW the lowest VISIBLE unread id (the
// ceiling we must never cross — advancing to/past it would mark real content
// read the operator never saw). When the whole post-cursor tail is hidden there
// is no ceiling, so the target is the tail id. Returns `cursor` when nothing is
// skippable, so the caller's forward-only `setCursorIfAdvances` (#233 monotonic
// clamp) makes it a no-op. Pure (predicate injected) — unit-testable without
// DOM/timers; the caller injects `presenceRowVisible(key, memberCount, kind)`.
export function trailingHiddenAdvanceTarget(
  msgs: readonly { readonly id: number; readonly kind: ScrollbackMessage["kind"] }[],
  cursor: number,
  isVisible: (kind: ScrollbackMessage["kind"]) => boolean,
): number {
  // Lowest-id VISIBLE unread — the ceiling. +Infinity when the whole
  // post-cursor tail is hidden (no visible unread to protect).
  let ceiling = Number.POSITIVE_INFINITY;
  for (const m of msgs) {
    if (m.id > cursor && isVisible(m.kind) && m.id < ceiling) ceiling = m.id;
  }
  // Highest HIDDEN unread id strictly below the ceiling — the skippable run.
  let target = cursor;
  for (const m of msgs) {
    if (m.id > cursor && !isVisible(m.kind) && m.id < ceiling && m.id > target) {
      target = m.id;
    }
  }
  return target;
}
