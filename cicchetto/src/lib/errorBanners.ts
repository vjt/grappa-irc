import { performRefresh, shouldShowRefreshBanner } from "./bundleHash";
import { isOffline } from "./connectivity";
import { shouldShowBanner, socketHealth } from "./socketHealth";

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
// EXTENSIBILITY for #120: the service-worker-registration-failure surface
// slots in as ONE new `BannerSource` member + one `activeBanners()` push
// gated on the SW-failure signal. Nothing structural changes — the enum + the
// derivation are the whole seam. (#120 is NOT implemented here.)

export const BANNER_SOURCES = ["connectivity", "ws", "bundle-refresh"] as const;
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

// Derive the currently-active banner entries from the source signals, in a
// deterministic order (errors before the informational bundle prompt). Reads
// each source's own accessor so the owner's <For> re-derives reactively when
// any source changes — a recovered source drops its slot automatically.
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
