import { createRoot, createSignal } from "solid-js";

// #217 — message-timestamp format preference. Closed-set union with
// localStorage persistence, backed by a module-singleton Solid signal so
// every open scrollback pane re-renders the moment the operator changes
// the format in Settings.
//
// ## Why closed-set keys, not a strftime string
//
// The issue proposed a "strftime-style pattern". A free-form format string
// is exactly the untyped-string-for-a-closed-set anti-pattern CLAUDE.md
// bans ("Atoms or `@type t :: literal | literal` — never untyped strings").
// The real user need is one axis — seconds or no seconds — so a two-key
// union is both the 10x-simpler shape (no strftime engine) and the typed
// one. New formats (12-hour, etc.) land as additional keys + one arm in
// `render`, never as a parsed pattern.
//
// ## Why a signal (deviation from fontSize.ts)
//
// theme.ts / fontSize.ts apply their effect as a boot-time DOM write
// (dataset / CSS var), so a plain localStorage read suffices. A timestamp
// format has no DOM-var analogue — it is consumed at render time by the
// message-row renderers. A bare `localStorage.getItem` inside the render
// path would NOT re-run when the setting changes. Backing the current key
// with a signal (createRoot, mirroring theme.ts's isMobile signal) makes
// `formatTimestamp` reactive: reading it inside a SolidJS render tracks the
// signal, so changing the format live re-renders scrollback + mentions.
//
// localStorage only — per feedback_no_localized_strings_server_side, cic
// owns UI/display preferences client-side; no server-side persistence, no
// wire change (issue #217 is explicitly client-only).

// "hms" = HH:MM:SS (with seconds, the #217 default); "hm" = HH:MM.
export type TimeFormatKey = "hms" | "hm";

const STORAGE_KEY = "cicchetto.timeFormat";
const DEFAULT_KEY: TimeFormatKey = "hms";

function isTimeFormatKey(v: string | null): v is TimeFormatKey {
  return v === "hms" || v === "hm";
}

function readStored(): TimeFormatKey {
  const v = localStorage.getItem(STORAGE_KEY);
  return isTimeFormatKey(v) ? v : DEFAULT_KEY;
}

// Module-singleton signal seeded from storage. createRoot anchors it for
// the app lifetime (same shape as theme.ts's isMobile) — the preference is
// identity-agnostic, so no token-rotation reset arm is needed.
const { current, setCurrent } = createRoot(() => {
  const [current, setCurrent] = createSignal<TimeFormatKey>(readStored());
  return { current, setCurrent };
});

export function getTimeFormat(): TimeFormatKey {
  return current();
}

export function setTimeFormat(key: TimeFormatKey): void {
  localStorage.setItem(STORAGE_KEY, key);
  setCurrent(key);
}

const pad = (n: number): string => n.toString().padStart(2, "0");

// Format an epoch-ms instant per a specific key — pure, TZ-local, testable
// without touching the signal. The public `formatTimestamp` below reads the
// reactive setting; call sites in the render path use that so they re-run
// on change.
export function renderTimestamp(epochMs: number, key: TimeFormatKey): string {
  const d = new Date(epochMs);
  const base = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return key === "hms" ? `${base}:${pad(d.getSeconds())}` : base;
}

// Format an epoch-ms instant per the CURRENT setting. Reading `current()`
// inside a SolidJS render tracks the signal, so message rows re-render live
// when the operator changes the format in Settings.
export function formatTimestamp(epochMs: number): string {
  return renderTimestamp(epochMs, current());
}
