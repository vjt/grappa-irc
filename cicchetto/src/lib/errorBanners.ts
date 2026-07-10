import { createSignal, untrack } from "solid-js";
import { performRefresh, shouldShowRefreshBanner } from "./bundleHash";
import { isOffline } from "./connectivity";
import { shouldShowBanner, socketHealth } from "./socketHealth";
import { shouldShowSwRegBanner, swRegistration } from "./swRegistration";

// #119 — unified stacked error-banner registry.
//
// ONE owner (`ErrorBanners.tsx`) renders N typed error entries STACKED
// vertically with no overlap, replacing the pre-#119 pair of independent
// `position: fixed; top: 0` banners (SocketHealthBanner + BundleRefreshBanner)
// that both painted on the same top coordinate and OVERLAPPED whenever both
// fired.
//
// The registry is DERIVED, not stored: `activeBanners()` reads the existing
// source signals (socketHealth, connectivity, bundleHash) and projects the
// currently-active ones into typed entries. No parallel store, no housekeeping
// — each source stays the single owner of its own state (CLAUDE.md design
// discipline: derive, don't duplicate).
//
// CLOSED SETS (CLAUDE.md "atoms or @type union of literals, never untyped
// strings for closed sets"): `source` and `severity` are string-literal unions
// with runtime guards (`isBannerSource` / `isBannerSeverity`) and a
// `sanitizeBanners` boundary that drops any entry outside the closed set.
//
// #120 extended this exactly as the seam promised: the
// service-worker-registration-failure surface is ONE new `BannerSource` member
// (`sw-registration`) + one `activeBanners()` push gated on the `swRegistration`
// signal's `shouldShowSwRegBanner()` predicate. Nothing structural changed — the
// enum + the derivation were the whole seam. The signal (`swRegistration.ts`)
// stays the single owner of the SW-registration state (derive, don't duplicate)
// and captures the error name+message as the #181 diagnostic lever.

export const BANNER_SOURCES = ["connectivity", "ws", "sw-registration", "bundle-refresh"] as const;
export type BannerSource = (typeof BANNER_SOURCES)[number];

export const BANNER_SEVERITIES = ["error", "warn", "info"] as const;
export type BannerSeverity = (typeof BANNER_SEVERITIES)[number];

export interface BannerAction {
  label: string;
  onAction: () => void;
}

export interface BannerEntry {
  source: BannerSource;
  severity: BannerSeverity;
  message: string;
  // Present only for user-actionable sources (bundle-refresh's reload). Its
  // absence vs presence — not a type flag — is the domain boundary between a
  // derived-and-auto-clearing source (ws, connectivity) and a
  // user-actionable-and-sticky one (bundle-refresh).
  actionHint?: BannerAction;
}

export function isBannerSource(x: unknown): x is BannerSource {
  return typeof x === "string" && (BANNER_SOURCES as readonly string[]).includes(x);
}

export function isBannerSeverity(x: unknown): x is BannerSeverity {
  return typeof x === "string" && (BANNER_SEVERITIES as readonly string[]).includes(x);
}

// Boundary guard — drop any entry whose source or severity is outside the
// closed set. In production `activeBanners()` only ever produces valid
// entries; this is the enforceable proof of the closed-set contract and the
// seam any future dynamically-sourced entry must pass through before render.
export function sanitizeBanners(entries: readonly BannerEntry[]): BannerEntry[] {
  return entries.filter((e) => isBannerSource(e.source) && isBannerSeverity(e.severity));
}

// The WS entry surfaces the real close code + reason (when the browser exposed
// one) — the honest "generic" diagnostics. The pre-#119 1006 "origin
// misconfigured" heuristic is deleted (a 1006 with no connection is the
// device being offline, which the connectivity source reports directly).
function wsMessage(): string {
  const h = socketHealth();
  const code = h.lastCloseCode ?? "unknown";
  const reason = h.lastCloseReason !== "" ? `: ${h.lastCloseReason}` : "";
  return `WebSocket connection failing — close code ${code}${reason} (${h.errorCount} consecutive errors).`;
}

// Surface the captured SW-registration error detail (name + message) — the same
// detail the swRegistration signal persists as the #181 diagnostic lever, here
// rendered as the human-visible cause. `warn`, not `error`: the app still works;
// only the SW-dependent capabilities (push, offline shell, badge) are degraded.
function swRegMessage(): string {
  const { error } = swRegistration();
  const detail = error !== null ? `${error.name}: ${error.message}` : "unknown error";
  return `Service worker registration failed — ${detail}. Offline mode and push notifications are unavailable.`;
}

// Derive the currently-active banner entries from the source signals, in a
// deterministic severity order (error sources, then the sw-registration warn,
// then the informational bundle prompt). Reads each source's own accessor so
// the owner's <For> re-derives reactively when any source changes — a recovered
// source drops its slot automatically.
export function activeBanners(): BannerEntry[] {
  const entries: BannerEntry[] = [];

  // Device offline — the honest connectivity signal (replaces the deleted
  // WS 1006 "origin misconfigured" heuristic). Auto-clears on `online`.
  if (isOffline()) {
    entries.push({
      source: "connectivity",
      severity: "error",
      message: "You appear to be offline — reconnecting automatically when the network returns.",
    });
  }

  // WS health — persistent handshake failures (server refused / dropped the
  // upgrade) surfaced with the real close code + reason. Auto-clears on a
  // clean reconnect (errorCount resets to 0 → below threshold).
  if (shouldShowBanner()) {
    entries.push({
      source: "ws",
      severity: "error",
      message: wsMessage(),
    });
  }

  // Service-worker registration failed — the pre-#120 silent-swallow, now
  // surfaced. Sticky (no auto-clear event; only reload re-attempts). `warn`:
  // degraded PWA capability, the app itself keeps working. The message carries
  // the captured error name+message (also the #181 diagnostic lever).
  if (shouldShowSwRegBanner()) {
    entries.push({
      source: "sw-registration",
      severity: "warn",
      message: swRegMessage(),
    });
  }

  // New cic bundle deployed — user-actionable refresh; persists until reload.
  if (shouldShowRefreshBanner()) {
    entries.push({
      source: "bundle-refresh",
      severity: "info",
      message: "New version available — a fresh cicchetto build was deployed.",
      actionHint: { label: "Refresh", onAction: () => void performRefresh() },
    });
  }

  return entries;
}

// #207 — client-local per-source dismiss.
//
// Pre-#207 the banners were STICKY: sw-registration and bundle-refresh have no
// auto-clear event (only a reload re-attempts them), so once shown they stayed
// up with no × and no timeout, piling up and obscuring the UI. The fix gives
// every banner a × affordance whose dismissed-state lives HERE, client-side.
//
// Two design constraints from CLAUDE.md, both load-bearing:
//   1. NEVER fabricate server state. The source signals (socketHealth,
//      connectivity, swRegistration, bundleHash) remain the single owners of
//      whether a source is active. Dismiss is a pure RENDER FILTER layered on
//      top — `activeBanners()` is unchanged; `visibleBanners()` is
//      `activeBanners()` minus the dismissed set.
//   2. A dismiss must NOT permanently silence a recurring fault
//      (feedback_silent_retry_anti_pattern). So the dismiss is scoped to the
//      CURRENT episode: `rearmDismissed()` (called by the owner on every
//      re-derivation) drops any dismissed source that is no longer active. When
//      the source recovers and later re-fires, its banner returns.
//
// Why NO auto-dismiss timer: ws + connectivity already auto-clear when the
// underlying condition recovers (a healthy open resets errorCount; the `online`
// event clears offline) — a timer hiding them WHILE the fault persists would
// mask a live problem. sw-registration is the #181 diagnostic surface and
// bundle-refresh is user-actionable; neither should vanish on a clock the user
// didn't ask for. The × (with re-arm) is the whole fix.
const [dismissed, setDismissed] = createSignal<ReadonlySet<BannerSource>>(new Set<BannerSource>());

// True iff this source is currently dismissed (hidden by an explicit ×).
export function isDismissed(source: BannerSource): boolean {
  return dismissed().has(source);
}

// Hide this source's banner client-locally until it recovers + re-fires.
export function dismissBanner(source: BannerSource): void {
  const next = new Set<BannerSource>(dismissed());
  next.add(source);
  setDismissed(next);
}

// Re-arm: forget any dismissal whose source is no longer in `active`. Called by
// the owner with the freshly-derived `activeBanners()` on every render so a
// recovered-then-recurring source surfaces again instead of staying silenced.
// No-op (no signal write) when nothing changes, so it's safe inside a tracked
// scope — it won't loop the reactive graph.
export function rearmDismissed(active: readonly BannerEntry[]): void {
  // Read the dismissed set UNTRACKED: the owner runs this inside a createEffect
  // that should depend only on the active set (passed in as `active`). Tracking
  // `dismissed()` here would make the effect self-trigger on its own write — a
  // bounded, converging no-op run, but the untrack makes the reactive
  // dependency exactly match intent (re-arm when the ACTIVE set changes).
  const current = untrack(dismissed);
  if (current.size === 0) return;
  const activeSources = new Set(active.map((e) => e.source));
  let changed = false;
  const next = new Set<BannerSource>();
  for (const source of current) {
    if (activeSources.has(source)) {
      next.add(source);
    } else {
      changed = true;
    }
  }
  if (changed) setDismissed(next);
}

// The render-facing projection: active sources minus the dismissed ones. This
// is what the owner (`ErrorBanners.tsx`) maps onto `BannerSlot`s.
export function visibleBanners(): BannerEntry[] {
  const active = activeBanners();
  const hidden = dismissed();
  return active.filter((e) => !hidden.has(e.source));
}

// Test-only — clear the dismissed set. Production code never calls this; the ×
// (dismiss) and recovery (rearm) are the only production mutators.
export function __resetDismissedForTests(): void {
  setDismissed(new Set<BannerSource>());
}
