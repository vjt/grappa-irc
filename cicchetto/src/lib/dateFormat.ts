import { createSignal } from "solid-js";
import { moduleRoot } from "./moduleRoot";
import { getTimeFormat, renderTimestamp, type TimeFormatKey } from "./timeFormat";

// issue 2270 — date NOTATION preference. The sibling of `timeFormat.ts` (#217)
// on the other half of the same instant, and deliberately built to its shape:
// a closed-set union, a module-singleton Solid signal, localStorage as the
// FOUC-free boot cache, and `displayPrefs.ts` carrying it over
// `GET/PUT /me/settings/display-prefs` so one account converges across devices.
//
// ## The bug this exists for
//
// Five user-facing sites formatted with a bare `toLocaleString()`, so the
// output inherited the JS runtime's default locale — which in a browser is the
// UI LANGUAGE, not the region. The reporter's iOS device has Preferred
// Language English and Region Italy, with its own Date Format set to
// `19/08/2026`; the page receives an English tag, `Intl` resolves a US default,
// and a device that says day-first renders `mm/dd`.
//
// ## Why a preference and not better sniffing
//
// Measured while the issue was decided: the web exposes no region, `en-IT` is
// not a real CLDR locale (ICU falls it back to `en` and renders `9/20/2026`),
// and the only day-first English locale is `en-GB` — which nothing on the page
// can derive. So the platform default is not merely weak here, it is PROVABLY
// unable to express a setting the user has already made elsewhere. The
// preference is the only channel that can carry it.
//
// ## Two independent inputs, and the key touches exactly one
//
// An instant needs a TIMEZONE and a notation needs a LOCALE, and they disagree
// on the reporter's devices (`en-US` + `Europe/Rome`). The TZ half was already
// correct and is untouched here. Of the locale half, this key governs ORDER
// only — never LANGUAGE. That split is why `renderDayLabel` takes both a key
// and a locale: an Italian viewer who asks for `dmy` must still read `lunedì`,
// and answering a notation question by switching the language to `en-GB` would
// be a worse bug than the one being fixed.
//
// ## Why `auto` is a real key
//
// Not the absence of a preference: absence cannot be distinguished from "never
// chose", and the drawer has to render something SELECTED. It resolves through
// `resolveLocale()` and must never collapse to a hardcoded `en-US` (vjt) — an
// Italian browser would regress, since today's buggy `toLocaleString()` already
// gets `gg/mm/aaaa` right there.

/** The closed set. `auto` defers to the resolved locale; the rest are orders. */
export type DateFormatKey = "auto" | "dmy" | "mdy" | "ymd";

/** Iteration order for the settings UI — also the order the ruling listed. */
export const DATE_FORMAT_KEYS: readonly DateFormatKey[] = ["auto", "dmy", "mdy", "ymd"];

const STORAGE_KEY = "cicchetto.dateFormat";
const DEFAULT_KEY: DateFormatKey = "auto";

// The end of the resolution chain, reached only when the browser exposes no
// language at all. `en-GB` and NOT `en-US`: vjt's constraint is that the chain
// must never bottom out on a month-first English default, and `en-GB` is the
// day-first English locale named in the issue. It is a floor, not an answer —
// `navigator.languages` is what normally decides.
export const FALLBACK_LOCALE = "en-GB";

export function isDateFormatKey(v: string | null): v is DateFormatKey {
  return v !== null && (DATE_FORMAT_KEYS as readonly string[]).includes(v);
}

function readStored(): DateFormatKey {
  const v = localStorage.getItem(STORAGE_KEY);
  return isDateFormatKey(v) ? v : DEFAULT_KEY;
}

// Module-singleton signal seeded from storage, exactly as timeFormat.ts does:
// the preference is consumed at RENDER time (there is no DOM-var analogue), so
// a bare localStorage read inside a renderer would not re-run when it changes.
const { current, setCurrent } = moduleRoot(() => {
  const [current, setCurrent] = createSignal<DateFormatKey>(readStored());
  return { current, setCurrent };
});

export function getDateFormat(): DateFormatKey {
  return current();
}

/** LOCAL-only write-through (signal + boot cache). The PUT belongs to
 * `displayPrefs.ts`'s `syncedSetDateFormat`, which is the single PUT door. */
export function setDateFormat(key: DateFormatKey): void {
  localStorage.setItem(STORAGE_KEY, key);
  setCurrent(key);
}

/**
 * The viewer's locale for date LANGUAGE, resolved once per call.
 *
 * `navigator.languages[0]` → `navigator.language` → `FALLBACK_LOCALE`. Read
 * defensively: a stubbed or exotic environment may carry neither, and this
 * runs inside render paths where a throw is a blank pane.
 */
export function resolveLocale(): string {
  const nav: Navigator | undefined = typeof navigator === "undefined" ? undefined : navigator;
  const first = nav?.languages?.[0];
  if (typeof first === "string" && first !== "") return first;
  const single = nav?.language;
  if (typeof single === "string" && single !== "") return single;
  return FALLBACK_LOCALE;
}

const pad = (n: number): string => n.toString().padStart(2, "0");

// What an unrenderable instant renders as. Every public renderer below is
// TOTAL — measured, and the measurement is the reason this exists: the code
// replaced here was `Date.prototype.toLocaleString()`, which answers the
// string "Invalid Date" for a non-finite instant, whereas
// `Intl.DateTimeFormat.format()` THROWS `RangeError: date value is not
// finite`. Swapping one for the other quietly turned a total function into a
// partial one, and these renderers run inside render paths where a throw is a
// blank pane, not a bad string. `RailContext.test.tsx` caught it on a bundle
// whose `signon` was absent.
//
// An em-dash rather than "Invalid Date": the JS artefact is exactly what
// `channelTopic.ts` already says it must never leak ("never leaks a JS
// 'Invalid Date' to the user"), and the call sites that HAVE a raw upstream
// string to fall back on still prefer it — their own guards run first.
const UNRENDERABLE = "—";

const renderable = (epochMs: number): boolean => Number.isFinite(epochMs);

/**
 * Render the DATE half of `epochMs` per `key`, in the runtime's local zone.
 *
 * The three explicit keys are assembled from the date's own fields and so are
 * locale-free BY CONSTRUCTION — handing `dmy` an `en-US` locale must still
 * produce day-first, which is the whole of issue 2270. `auto` is the one key
 * that delegates, and it delegates to `locale`.
 */
export function renderDate(epochMs: number, key: DateFormatKey, locale: string): string {
  if (!renderable(epochMs)) return UNRENDERABLE;
  const d = new Date(epochMs);
  const day = pad(d.getDate());
  const month = pad(d.getMonth() + 1);
  const year = d.getFullYear().toString();

  switch (key) {
    case "dmy":
      return `${day}/${month}/${year}`;
    case "mdy":
      return `${month}/${day}/${year}`;
    case "ymd":
      return `${year}-${month}-${day}`;
    case "auto":
      return new Intl.DateTimeFormat(locale, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(d);
  }
}

/**
 * Date + time, the composite the four `toLocaleString()` sites were rendering.
 *
 * The time half comes from `timeFormat.ts` rather than from a second `Intl`
 * call, which is a deliberate change of behaviour and not an accident: the app
 * already owns a "with/without seconds" preference and already renders 24h in
 * scrollback, so delegating here would reintroduce a locale dependency (an
 * `en-US` viewer got `12:05:07 AM`) on the very axis being fixed, and would
 * make two timestamps on one screen disagree about their own format.
 */
export function renderDateTime(
  epochMs: number,
  key: DateFormatKey,
  locale: string,
  timeKey: TimeFormatKey,
): string {
  if (!renderable(epochMs)) return UNRENDERABLE;
  return `${renderDate(epochMs, key, locale)} ${renderTimestamp(epochMs, timeKey)}`;
}

/**
 * The scrollback day-separator label: weekday and month as WORDS.
 *
 * `auto` hands the whole string to `Intl` so each locale keeps its own
 * punctuation (measured: `en-GB` carries no comma, `en-US` does). An explicit
 * key cannot: the user asked for a field order, and a long-form month has
 * none to give — `ymd` in particular has no word form at all. So the weekday
 * stays localized and the rest becomes the chosen notation.
 *
 * EVERY key carries the year outside the CURRENT local year, and no key
 * carries it inside one. The explicit three get it from `renderDate`, which
 * has always written it; `auto` adds it here (issue 2304, vjt #grappa
 * 2026-09-27 21:18), where it used to be absent at every distance. A
 * separator in a scrollback that spans a year is better for it — and so is
 * the floating date pill, which shares this label rather than minting a
 * second one, so the rule lands on both consumers at once. Current-year
 * labels are byte-identical to what they were.
 *
 * `nowMs` is a PARAMETER and not a `Date.now()` read, for the same reason
 * `locale` is: this renderer takes its ambient inputs explicitly and
 * `formatDayLabel` below is the one door that resolves them. It also leaves
 * nothing for a test to read by accident — a suite asserting "no year" while
 * silently consulting the real clock passes until the calendar turns over.
 * A non-finite `nowMs` compares equal to no year, so a broken clock renders
 * the year ALWAYS: more information, never a throw.
 */
export function renderDayLabel(
  epochMs: number,
  key: DateFormatKey,
  locale: string,
  nowMs: number,
): string {
  if (!renderable(epochMs)) return UNRENDERABLE;
  const d = new Date(epochMs);
  if (key === "auto") {
    // `undefined` is how `Intl` is told a component is ABSENT — the option bag
    // is read with a plain Get, so this is the same object shape as before for
    // a current-year day, not a request for a default.
    const inCurrentYear = d.getFullYear() === new Date(nowMs).getFullYear();
    return new Intl.DateTimeFormat(locale, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: inCurrentYear ? undefined : "numeric",
    }).format(d);
  }
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "long" }).format(d);
  return `${weekday}, ${renderDate(epochMs, key, locale)}`;
}

// ---------------------------------------------------------------------------
// The reactive doors. Reading `current()` / `getTimeFormat()` inside a SolidJS
// render tracks both signals, so every pane re-formats live when either
// preference changes — the #217 seam, reused rather than rebuilt.
// ---------------------------------------------------------------------------

/** Date + time per the CURRENT preferences. The four card/topic sites call this. */
export function formatDateTime(epochMs: number): string {
  return renderDateTime(epochMs, current(), resolveLocale(), getTimeFormat());
}

/** The day-separator label per the CURRENT preference, on the CURRENT year. */
export function formatDayLabel(epochMs: number): string {
  return renderDayLabel(epochMs, current(), resolveLocale(), Date.now());
}
