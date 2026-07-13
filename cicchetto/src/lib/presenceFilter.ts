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

// Back to follow-the-size-default: remove the explicit pin entirely.
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
