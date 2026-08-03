import { type Accessor, createEffect } from "solid-js";

// #695 — reload the whole client on resume after a prolonged absence.
//
// A long-lived PWA document degrades ("Safari goes mad after a while"), so a
// document iOS suspended for two days is worth throwing away rather than
// resuming. Deliberately independent of the bundle-hash refresh (#674): that
// one fires on a deploy, this one on elapsed inactivity whether or not a new
// bundle exists. Both reach the SAME reload verb — `bundleHash.performRefresh`
// — because a second reload path beside it would be a second consumer of the
// same SW/cache dance (the three-presses-to-update bug it exists to fix).
//
// The interval is measured from a PERSISTED stamp, never from in-memory state
// or a timer. That is the whole point: the document may have been frozen for
// the entire window with no JS running, so nothing in the page can have
// counted the hours. Only storage crosses the suspension.
//
// TWO STORES, on purpose:
//   * the stamp lives in sessionStorage — it means "when was THIS document
//     last alive", and sessionStorage is exactly per-window-lifetime: it
//     survives a reload and a suspension, and it does not leak between tabs.
//     In localStorage a foreground desktop tab would keep refreshing the
//     shared stamp and the suspended PWA — the degraded document this whole
//     feature exists for — would never trip.
//   * the threshold override lives in localStorage: device-wide operator
//     config that must outlive any one window.
//
// ONE RULE keeps "reload exactly once" true: every check stamps, and the
// stale ones also reload. Because the stamp is refreshed as the reload is
// requested, no later trigger in this document can see the same absence
// twice, and a reload that never lands (a blocked navigation, the e2e
// `__refreshProbe`) leaves the document healthy rather than wedged — a
// boolean latch would have disabled the feature for that document's whole
// remaining life. `installStaleResumeReload` also stamps BEFORE arming any
// trigger, so the document that just reloaded cannot immediately reload on
// the absence it was itself the answer to.
//
// Threshold: 48h by default (24h was considered and rejected as too eager),
// overridable per device via `localStorage["cicchetto.staleResumeHours"]` so
// the number can be tuned without a deploy-shaped argument. An absent,
// non-numeric or non-positive override falls back to the default — a typo
// must never turn into "reload on every resume".

export const STALE_RESUME_STAMP_KEY = "cicchetto.lastActiveAt";
export const STALE_RESUME_HOURS_KEY = "cicchetto.staleResumeHours";
export const DEFAULT_STALE_RESUME_HOURS = 48;

const MS_PER_HOUR = 3_600_000;

// The `pageshow` seam. Narrow on purpose: `installStaleResumeReload` has no
// uninstall path (a real listener outlives its test), so unit tests pass a
// fake rather than the real window — the same shape #649 uses for the
// viewport resume triggers.
export interface ResumeWindowLike {
  addEventListener(event: "pageshow", handler: () => void): void;
}

export interface StaleResumeDeps {
  // The visibility SSOT (`documentVisibility.ts` — visibilitychange AND
  // window focus/blur). Consumed as a signal rather than re-registering
  // parallel listeners.
  isVisible: Accessor<boolean>;
  now: () => number;
  reload: () => void;
  win: ResumeWindowLike;
}

/** The effective inactivity threshold in ms — the stored override, else 48h. */
export function staleResumeThresholdMs(): number {
  const raw = localStorage.getItem(STALE_RESUME_HOURS_KEY);
  const hours = raw === null ? Number.NaN : Number(raw);
  const effective = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_STALE_RESUME_HOURS;
  return effective * MS_PER_HOUR;
}

/** Record that this document was alive at `now`. */
export function markActive(now: number): void {
  sessionStorage.setItem(STALE_RESUME_STAMP_KEY, String(now));
}

/** The persisted stamp, or null when absent or unparseable. */
export function readLastActive(): number | null {
  const raw = sessionStorage.getItem(STALE_RESUME_STAMP_KEY);
  if (raw === null) return null;
  const stamp = Number(raw);
  return Number.isFinite(stamp) ? stamp : null;
}

/**
 * Has the document been away long enough to be worth throwing away?
 *
 * Strictly greater than the threshold, and false with no stamp — a
 * first-ever boot has nothing to be stale against.
 */
export function isStaleResume(
  now: number,
  lastActive: number | null,
  thresholdMs: number,
): boolean {
  return lastActive !== null && now - lastActive > thresholdMs;
}

/**
 * Arm the stale-resume reload and return the check verb.
 *
 * Checks on every resume trigger: the visibility signal (tab switch,
 * app-switch, desktop focus) and `pageshow` (the bfcache/PWA restore whose
 * computed visibility never changed, so the signal never fires). The returned
 * verb is that SAME check, handed to the #318 foreground heartbeat by
 * `main.tsx` — on iOS the background transition frequently never fires at
 * all, and the first tick after a thaw is then the only trigger that can
 * observe the absence. Handing out the check rather than the stamp writer
 * keeps ONE writer of the stamp: a caller that stamped without checking would
 * erase the very evidence the feature runs on.
 *
 * Overlapping triggers are free: the check is idempotent once the stamp is
 * refreshed, exactly as #649 argues for its three viewport resume triggers.
 */
export function installStaleResumeReload(deps: StaleResumeDeps): () => void {
  const check = (): void => {
    const now = deps.now();
    const stale = isStaleResume(now, readLastActive(), staleResumeThresholdMs());
    // Stamp FIRST, unconditionally: this is what makes the reload fire once
    // per absence rather than once per trigger.
    markActive(now);
    if (stale) deps.reload();
  };

  // BEFORE arming anything — see the loop guard in the module header.
  markActive(deps.now());

  deps.win.addEventListener("pageshow", check);
  createEffect(() => {
    // Tracked: any visibility transition, in either direction. Going hidden
    // stamps the precise moment the operator left, which is a better
    // baseline than the last heartbeat tick.
    deps.isVisible();
    check();
  });

  return check;
}
