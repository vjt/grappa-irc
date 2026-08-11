import type { AdminSessionLogEntry } from "../lib/api";

// #1224 — how a lifecycle-log record reads on screen, shared by the two
// surfaces that render one: the Sessions drill-down (a live row whose
// last logged event happens to be a disconnect) and the ended-sessions
// sub-page (rows that are nothing BUT the record).
//
// Extracted from `AdminSessionsTab` rather than copied into the page:
// the two would drift, and "lasted 1h0m" reading differently on two
// screens of the same tab is the kind of drift nobody reports and
// everybody notices.
//
// `AdminSessionLogTab.humanDuration` is a THIRD formatter with a
// different shape (`1h 0m`, and `ms` below a second) and is deliberately
// left alone: it renders a raw event log where sub-second spacing is the
// story, and folding it into this one would change that tab's output for
// no reason #1224 asks for.

/** Human duration for a session that has ended. Raw milliseconds are
 * unreadable at the scale a bouncer session actually runs for. */
export function renderDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h${m % 60}m` : `${Math.floor(h / 24)}d${h % 24}h`;
}

/** Why it stopped, and whether the stop was orderly. `null` reason is
 * "the log recorded none", which is not the same as a clean exit. */
export function renderReason(e: AdminSessionLogEntry): string {
  const clean = e.clean === null ? "" : e.clean ? " (clean)" : " (unclean)";
  return `${e.reason ?? "no reason recorded"}${clean}`;
}

/** The one-line form, for a drill-down fact: reason, cleanliness and how
 * long it had been up. Each part is dropped when the row lacks it. */
export function renderEnded(e: AdminSessionLogEntry): string {
  const lasted = e.duration_ms === null ? "" : `, lasted ${renderDuration(e.duration_ms)}`;
  return `${renderReason(e)}${lasted}`;
}
