import { createSignal, untrack } from "solid-js";
import { performRefresh, refreshBannerMessage, shouldShowRefreshBanner } from "./bundleHash";
import { acceptInvite } from "./channelJoin";
import { isOffline } from "./connectivity";
import { acceptPushOptin, shouldShowPushOptinBanner } from "./pushOptin";
import { shouldShowBanner, socketHealth } from "./socketHealth";
import { shouldShowSwRegBanner, swRegistration } from "./swRegistration";
import { type InvitedWindow, invitedWindows } from "./windowState";

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

export const BANNER_SOURCES = [
  "connectivity",
  "ws",
  "sw-registration",
  "bundle-refresh",
  "push-optin",
  "invite",
] as const;
export type BannerSource = (typeof BANNER_SOURCES)[number];

export const BANNER_SEVERITIES = ["error", "warn", "info"] as const;
export type BannerSeverity = (typeof BANNER_SEVERITIES)[number];

export interface BannerAction {
  label: string;
  onAction: () => void;
}

// #902 — the identity a DISMISS is scoped to. Every source before `invite`
// had exactly one live entry, so the source WAS the instance and the
// dismissed set could be keyed on it. `invite` breaks that: there is one
// entry per invited channel.
//
// This is not a preference, it is correctness. With a single aggregate
// entry, a × taken while other invites are still live keeps the SOURCE
// active, so `rearmDismissed` never re-arms it and the NEXT invite — a
// different channel, a different peer — is silently swallowed. That is
// exactly the failure `rearmDismissed`'s own contract forbids ("a dismiss
// must never permanently silence a recurring fault"). Keying on the entry
// instead makes the re-arm correct for free: when #a's invite resolves, only
// `invite:#a` leaves the active set, so only its dismissal is forgotten.
export type BannerId = string;

export interface BannerEntry {
  source: BannerSource;
  // Dismiss identity. Single-instance sources omit it and fall back to the
  // source name (`entryId` below), so nothing about the other five changed.
  id?: BannerId;
  severity: BannerSeverity;
  message: string;
  // Present only for user-actionable sources (bundle-refresh's reload). Its
  // absence vs presence — not a type flag — is the domain boundary between a
  // derived-and-auto-clearing source (ws, connectivity) and a
  // user-actionable-and-sticky one (bundle-refresh).
  actionHint?: BannerAction;
}

// The one place the source-or-id fallback is resolved. Every dismiss-side
// read goes through it so a caller can never key on `source` by accident and
// re-introduce the aggregate bug described above.
export function entryId(entry: BannerEntry): BannerId {
  return entry.id ?? entry.source;
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
  // #292 — the message now shows current-vs-available version (semver +
  // short build-hash suffix), composed by bundleHash (the owner of the
  // version+hash signals).
  if (shouldShowRefreshBanner()) {
    entries.push({
      source: "bundle-refresh",
      severity: "info",
      message: refreshBannerMessage(),
      actionHint: { label: "Refresh", onAction: () => void performRefresh() },
    });
  }

  // #902 — inbound INVITEs. LOW in the stack, beside push-optin: an invite is
  // an OFFER, not a fault, so it never outranks "you are disconnected" or an
  // update prompt. Just ABOVE push-optin, though: an invite is a specific,
  // time-sensitive offer from a person, where push-optin is a standing
  // app-level one. That also keeps "push-optin is LAST" an unconditional
  // invariant rather than one that holds only when nobody has invited you.
  //
  // ONE ENTRY PER INVITED CHANNEL, each with its own `id`. See `BannerId`
  // above for why an aggregate entry would be wrong rather than merely
  // terse. N stacked banners is a real wall, but concurrent invites are rare
  // and stacking N without overlap is precisely what #119 built.
  //
  // Derived, never stored: `invitedWindows()` reads the server-owned
  // window-state map (`userTopic.ts`'s `window_invited` arm is the single
  // owner). This registry holds nothing of its own, so there is no state to
  // reconcile when an invite resolves — the entry simply stops being derived,
  // and `rearmDismissed` forgets any × taken on it.
  //
  // Both controls are session-scoped and write NOTHING persistent (vjt's
  // ruling): [Join] joins and the entry disappears because the state leaves
  // `:invited`; × hides it for this page life only. The server re-emits
  // `window_invited` on every cold subscribe, so a dismissed invite returns
  // after a reload — accepted, because an invite is allowed to be lost and
  // the peer can simply invite again. Deliberately NOT the persistent decline
  // `push-optin` uses.
  for (const invite of invitedWindows()) {
    entries.push(inviteEntry(invite));
  }

  // #459 — push opt-in offer. LAST in the stack: an offer never outranks a
  // fault ("you are disconnected"), an update prompt, or a person waiting on
  // an answer. Gated + actioned by pushOptin.ts (the source owner); the
  // registry only projects the gate into an info entry and wires [of course!]
  // to the accept verb. The × is the decline — routed by the owner
  // (ErrorBanners.tsx) to declinePushOptin so it PERSISTS, unlike the
  // episode-scoped dismiss every other source uses.
  if (shouldShowPushOptinBanner()) {
    entries.push({
      source: "push-optin",
      severity: "info",
      message: "Enable push notifications?",
      actionHint: { label: "of course!", onAction: () => void acceptPushOptin() },
    });
  }

  return entries;
}

// One invite → one entry. Split out so the id shape has a single
// definition. It carries the NETWORK as well as the channel, so two
// networks inviting to the same channel name stay independently
// dismissable — and `:`-joined rather than reusing the raw `ChannelKey`
// (which is space-joined) so it reads cleanly as the `data-banner-id`
// attribute selector the e2e suite observes.
function inviteEntry(invite: InvitedWindow): BannerEntry {
  return {
    source: "invite",
    id: `invite:${invite.networkSlug}:${invite.channelName}`,
    severity: "info",
    message: `${invite.inviter} is inviting you to ${invite.channelName}`,
    actionHint: {
      label: "Join",
      // The SAME verb the invite row's [Join] CTA in scrollback calls.
      onAction: () => acceptInvite(invite.networkSlug, invite.channelName),
    },
  };
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
//
// #902 — the set is keyed on `entryId`, not on `source`. See the `BannerId`
// note above for why that distinction is a correctness one.
const [dismissed, setDismissed] = createSignal<ReadonlySet<BannerId>>(new Set<BannerId>());

// True iff this entry is currently dismissed (hidden by an explicit ×).
export function isDismissed(id: BannerId): boolean {
  return dismissed().has(id);
}

// Hide this entry's banner client-locally until it clears + re-fires.
export function dismissBanner(id: BannerId): void {
  const next = new Set<BannerId>(dismissed());
  next.add(id);
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
  const activeIds = new Set(active.map(entryId));
  let changed = false;
  const next = new Set<BannerId>();
  for (const id of current) {
    if (activeIds.has(id)) {
      next.add(id);
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
  return active.filter((e) => !hidden.has(entryId(e)));
}

// Test-only — clear the dismissed set. Production code never calls this; the ×
// (dismiss) and recovery (rearm) are the only production mutators.
export function __resetDismissedForTests(): void {
  setDismissed(new Set<BannerId>());
}
