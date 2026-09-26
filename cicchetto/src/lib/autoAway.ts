/**
 * #348 — the auto-away debounce preference, cached client-side.
 *
 * The server owns the behaviour: it is the thing that waits and then
 * sends `AWAY` upstream. cic only reads the stored preference so the
 * settings control can render it, writes it when the user changes it,
 * and mirrors the server's push so a change made on the phone shows up
 * on the laptop without a reload.
 *
 * Three states in one value, matching the wire: `null` = no preference
 * (the server's own default applies — a number cic deliberately does
 * not know), `0` = off, `N` = seconds.
 *
 * ## #1894 — the nick suffix lives here too
 *
 * The second cache below is the suffix appended to the nick while that
 * same auto-away is held. It sits beside the debounce because it belongs
 * to the same FEATURE, not because it shares a type — it is a string and
 * the debounce is a number. `leaveReasons.ts` groups by the opposite
 * criterion (two opaque texts with one shared rule) and a nick fragment
 * with a charset is neither a leave reason nor opaque.
 *
 * Only TWO states here, and `null` is the plain one: the rename is off,
 * which is the default. Unlike the debounce's `null`, it hides no
 * server-side value — nothing happens at all.
 */

import { createSignal } from "solid-js";
import {
  getAutoAwayDebounceSeconds,
  getAwayNickSuffix,
  putAutoAwayDebounceSeconds,
  putAwayNickSuffix,
} from "./userSettings";

const [autoAwayDebounce, setAutoAwayDebounceSignal] = createSignal<number | null>(null);
const [awayNickSuffix, setAwayNickSuffixSignal] = createSignal<string | null>(null);

/** The cached preference: `null` (server default), `0` (off) or seconds. */
export function autoAwayDebounceValue(): number | null {
  return autoAwayDebounce();
}

/**
 * Load the stored preference into the cache. Errors are swallowed: the
 * cache stays at `null`, which renders as "use site default" — the same
 * thing the server does for a subject with no preference, so a failed
 * read shows the truth rather than a wrong number.
 */
export async function loadAutoAwayDebounce(token: string): Promise<void> {
  try {
    setAutoAwayDebounceSignal(await getAutoAwayDebounceSeconds(token));
  } catch {
    /* swallowed — the control falls back to "use site default" */
  }
}

/**
 * Persist a new preference and mirror what the server echoed back — not
 * what we sent. Throws `ApiError` on 4xx/5xx so the caller can surface
 * the server's message (which is where the accepted range is spelled).
 */
export async function saveAutoAwayDebounce(token: string, seconds: number | null): Promise<void> {
  setAutoAwayDebounceSignal(await putAutoAwayDebounceSeconds(token, seconds));
}

/**
 * Adopt a change the SERVER announced (the `auto_away_debounce_changed`
 * push, fired for every write including ones from another device). cic
 * never originates this state — it only mirrors it.
 */
export function applyAutoAwayDebounceFromWire(seconds: number | null): void {
  setAutoAwayDebounceSignal(seconds);
}

/** The cached auto-away nick suffix: `null` when the rename is off. */
export function awayNickSuffixValue(): string | null {
  return awayNickSuffix();
}

/**
 * Load the stored suffix into the cache. Errors are swallowed: the cache
 * stays at `null`, which renders as an empty field — the same thing the
 * server reports for a subject who never switched the rename on, so a
 * failed read shows the truth rather than a suffix cic invented.
 */
export async function loadAwayNickSuffix(token: string): Promise<void> {
  try {
    setAwayNickSuffixSignal(await getAwayNickSuffix(token));
  } catch {
    /* swallowed — the control falls back to "off" */
  }
}

/**
 * Persist a new suffix and mirror what the server echoed back — not what
 * we sent. The distinction is load-bearing: post `""` and the server
 * answers `null`, and the control must show the off state rather than an
 * empty string it invented.
 */
export async function saveAwayNickSuffix(token: string, suffix: string | null): Promise<void> {
  setAwayNickSuffixSignal(await putAwayNickSuffix(token, suffix));
}

/** Adopt a server-announced `away_nick_suffix_changed`. */
export function applyAwayNickSuffixFromWire(suffix: string | null): void {
  setAwayNickSuffixSignal(suffix);
}

/** Test-only: drop both caches back to their "nothing stored" state. */
export function resetAutoAwayDebounceForTests(): void {
  setAutoAwayDebounceSignal(null);
  setAwayNickSuffixSignal(null);
}
