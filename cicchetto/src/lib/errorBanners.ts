import { createSignal, untrack } from "solid-js";
import { refreshBannerMessage, shouldShowRefreshBanner } from "./bundleHash";
import { requestBundleRefreshNow } from "./bundleRefreshNotice";
import { acceptInvite, declineInvite } from "./channelJoin";
import { isOffline } from "./connectivity";
import { acceptDccOffer, refuseDccOffer } from "./dccConsent";
import { type DccOffer, dccOffersById } from "./dccOffers";
import { formatBytes } from "./formatBytes";
import { acceptPushOptin, declinePushOptin, shouldShowPushOptinBanner } from "./pushOptin";
import { serverOutdatedMessage, shouldShowServerOutdatedBanner } from "./serverProtocol";
import {
  clearShareTargetBlock,
  shareTargetBannerMessage,
  shouldShowShareTargetBanner,
} from "./shareTargetOutcome";
import { shouldShowBanner, socketHealth } from "./socketHealth";
import { shouldShowSwRegBanner, swRegistration } from "./swRegistration";
import { type InvitedWindow, invitedWindows } from "./windowState";
import { shouldShowWireDropBanner, wireDropMessage } from "./wireDrop";

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
  // #1393d — two NEW members, and they are deliberately two.
  //
  // `server-outdated` is the DIAGNOSIS: the server named a wire protocol
  // below what this bundle requires, which it does in the user-topic join
  // reply before any payload arrives. `wire-drop` is the SYMPTOM: a narrower
  // rejected something and cic threw it away, which a mangling proxy causes
  // just as readily as a stale BEAM.
  //
  // Folding them into one entry was the tempting move and it is wrong: a
  // drop with no protocol mismatch is a DIFFERENT incident from a stale
  // BEAM, and one that told the operator to go update the server would send
  // them after a cause that is not there. Same seam #120 used — one enum
  // member, one derivation, each signal still the sole owner of its state.
  "server-outdated",
  "wire-drop",
  "sw-registration",
  "bundle-refresh",
  "push-optin",
  "invite",
  "share-target",
  // issue 2089 — a peer offered a file and the bouncer is HOLDING it. One
  // more member, one more derivation: the same seam #120 and #902 used, and
  // the reason vjt's ruling says "banner, same pattern as the invite" —
  // there was nothing structural left to build.
  "dcc-offer",
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
  // #976 — the source-owned meaning of the ×, when the episode-scoped hide is
  // the wrong verb. `label` is the ×'s accessible name (a control that
  // DECLINES an invite must not be announced as "dismiss notification"),
  // `onAction` the verb. Absent ⇒ `dismissBanner(entryId(entry))`, the
  // hide-until-it-recurs the fault sources want.
  //
  // Data, not a branch in the owner: pre-#976 `ErrorBanners.tsx` carried a
  // `source === "push-optin" ? … : …` ternary, and #976 would have made it a
  // three-arm one that has to reconstruct the invite's (network, channel)
  // by parsing `entry.id` back apart. The registry already holds both, so the
  // verb belongs here — with it, the owner has no per-source knowledge at all.
  dismiss?: BannerAction;
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
  //
  // #1061 — SUPPRESSED while the device is offline. The two entries were
  // independent, so an offline device stacked "WebSocket connection failing —
  // close code 1006 (15 consecutive errors)" on top of "You appear to be
  // offline". That is not two faults, it is one fault reported twice, and the
  // second report is the WRONG one: a raw close code and a frozen error tally
  // (`errorCount` only resets in `recordSocketOpen`, so offline it can never
  // come down) describe a symptom of the first. The connectivity entry states
  // the actual cause, so it is the one that survives.
  //
  // This is a SUPPRESSION, not a merge: nothing is lost. When the device comes
  // back online and the WS is still failing, the entry returns on its own —
  // and `rearmDismissed` forgets any × taken on it in the meantime, so a
  // genuine server-side failure can never be silenced by an offline episode.
  if (!isOffline() && shouldShowBanner()) {
    entries.push({
      source: "ws",
      severity: "error",
      message: wsMessage(),
    });
  }

  // #1393d — the server is older than this bundle can talk to. `error`, and
  // ABOVE the drop banner below, because it is the cause of it whenever both
  // are up: a reader who has been told the server is stale does not need to
  // be told separately that data went missing.
  //
  // No `actionHint`. Every other user-actionable entry here offers something
  // the READER can do, and there is nothing: reloading re-fetches the same
  // bundle against the same BEAM. Offering a reload would be a button that
  // reliably changes nothing, which is how a banner teaches people to ignore
  // banners.
  if (shouldShowServerOutdatedBanner()) {
    entries.push({
      source: "server-outdated",
      severity: "error",
      message: serverOutdatedMessage(),
    });
  }

  // #1393d — cic discarded an update it could not read. `warn`, not `error`:
  // the pane it belonged to is stale, the app is not broken. Sticky, because
  // the drop already happened and nothing later un-drops it; the × is the
  // reader saying they have seen it.
  if (shouldShowWireDropBanner()) {
    entries.push({
      source: "wire-drop",
      severity: "warn",
      message: wireDropMessage(),
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

  // #1103 — a share the OS handed us that could not be delivered. `warn`, and
  // above the offer-shaped entries below: the operator did something a moment
  // ago and the app has to answer for it, which outranks any standing prompt.
  //
  // Reported, not derived. Every other source here reads a condition that is
  // still true while the banner is up (offline, invited, a newer bundle); a
  // failed share is an EVENT with nothing left behind to observe, so the
  // reader records it and the × ends it. Hence the explicit `dismiss` verb —
  // the default × hides until the source recurs, and there is nothing to
  // recur.
  if (shouldShowShareTargetBanner()) {
    entries.push({
      source: "share-target",
      severity: "warn",
      message: shareTargetBannerMessage(),
      dismiss: { label: "Dismiss", onAction: () => clearShareTargetBlock() },
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
      // #1063 — `"user"` because a human pressed it, and that is what buys the
      // "Still on X" answer when the reload lands on the same bundle. The
      // silence this replaces was the complaint: the page comes back looking
      // identical with the same banner on it, so "it did not work" and "I
      // mis-tapped" are the same picture.
      actionHint: { label: "Refresh", onAction: () => void requestBundleRefreshNow("user") },
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
  // #976 REVERSES the #902 ruling this comment used to record. Both controls
  // now ANSWER the invite: [Join] accepts (the state leaves `:invited`), × is
  // the DECLINE (the server drops the window and fans the drop out). There is
  // no third "hide for now" affordance — one control, one meaning.
  //
  // #902 had ruled the × session-scoped on the grounds that "an invite is
  // allowed to be lost". True in principle, false in the code: nothing ever
  // moved a channel out of `:invited` except JOINing it, so the server
  // re-emitted `window_invited` on every cold subscribe and the invite came
  // back at the top of the page until the operator gave in. An offer you
  // cannot refuse is not an offer.
  //
  // The decline is still LOCAL — IRC has no DECLINE verb, so nothing reaches
  // the peer or the server upstream. The copy says so out loud rather than
  // leaving the operator to guess whether refusing is a snub.
  // issue 2089 — held DCC offers, ABOVE the invites and for a reason that is
  // measurable rather than a matter of taste: this offer EXPIRES. The server
  // resolves it `expired` on its own, so ignoring it is a way to lose it. An
  // invite is not lost by waiting — nothing drops an `:invited` window except
  // answering it, and the server re-announces it on every cold subscribe
  // (that is exactly what #976 was filed about). The entry that a delay can
  // destroy goes first.
  //
  // Still BELOW every fault and the update prompt, like the invite: an offer
  // never outranks "you are disconnected".
  //
  // Derived, never stored — `dccOffersById()` is the mirror of the set the
  // server is holding, and the registry keeps nothing of its own. When the
  // server resolves an offer the entry simply stops being derived, here and
  // on every other device.
  for (const offer of Object.values(dccOffersById())) {
    entries.push(dccOfferEntry(offer));
  }

  for (const invite of invitedWindows()) {
    entries.push(inviteEntry(invite));
  }

  // #459 — push opt-in offer. LAST in the stack: an offer never outranks a
  // fault ("you are disconnected"), an update prompt, or a person waiting on
  // an answer. Gated + actioned by pushOptin.ts (the source owner); the
  // registry only projects the gate into an info entry and wires [of course!]
  // to the accept verb. The × is the decline, and it PERSISTS (localStorage,
  // via the owner) unlike the episode-scoped dismiss the fault sources use.
  //
  // #976 — that decline used to be a `source === "push-optin"` ternary in
  // `ErrorBanners.tsx`; it rides `dismiss` now, like the invite's. Same verb,
  // same behaviour, one fewer place that knows which source is special.
  if (shouldShowPushOptinBanner()) {
    entries.push({
      source: "push-optin",
      severity: "info",
      message: "Enable push notifications?",
      actionHint: { label: "of course!", onAction: () => void acceptPushOptin() },
      dismiss: { label: "Decline push notifications", onAction: () => declinePushOptin() },
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
    // #976 — the copy names what the × does AND what it does not do. Making
    // the locality explicit is the point: an operator who suspects declining
    // notifies the inviter will ignore the banner instead, which is the
    // behaviour the issue was filed about.
    message: `${invite.inviter} is inviting you to ${invite.channelName}. × declines it quietly — nothing is sent to the IRC server.`,
    actionHint: {
      label: "Join",
      // The SAME verb the invite row's [Join] CTA in scrollback calls.
      onAction: () => acceptInvite(invite.networkSlug, invite.channelName),
    },
    // #976 — the × is the DECLINE, not the episode-scoped hide. Labelled as
    // such: a screen reader announcing "dismiss notification" would describe
    // a control that no longer does that.
    dismiss: {
      label: `Decline the invite to ${invite.channelName} — nothing is sent to the IRC server`,
      onAction: () => declineInvite(invite.networkSlug, invite.channelName),
    },
  };
}

// One held offer → one entry. Three things the copy has to get right, each
// one a way the operator could be misled:
//
//   * the SIZE is the sender's CLAIM, not a fact — they declare it in the
//     CTCP and the transfer truncates at it. Stating it flat would have
//     grappa vouching for a stranger's number. Rendered through the shared
//     `formatBytes` (#411) so a size reads the same here as in every other
//     cap/size surface in cic.
//   * ACCEPTING lands the file on the BOUNCER, not on this device: the door
//     answers 202, the transfer runs detached, and the bytes are fetched
//     later over the file door. "Accept" read as "download to my phone now"
//     is the wrong mental model to leave someone with.
//   * the PLACEMENT (`offer.channel`) is deliberately NOT in the copy. It is
//     frequently `$server` — an offer from someone with no open conversation
//     routes there (the #546 rule: a stranger's CTCP mints no window) — and
//     "in $server" names an implementation detail as if it were a room.
//
// The id is network-qualified like the invite's. `offer_id` is already
// server-minted and opaque, but two networks mint independently, and the
// qualification costs nothing while a collision would silently merge two
// strangers' files into one banner.
function dccOfferEntry(offer: DccOffer): BannerEntry {
  return {
    source: "dcc-offer",
    id: `dcc-offer:${offer.network}:${offer.offer_id}`,
    severity: "info",
    message: `${offer.from} is offering you a file: ${offer.filename} (${formatBytes(offer.size)}, the sender's claim). Accepting downloads it to grappa, not to this device.`,
    actionHint: {
      label: "Accept",
      onAction: () => acceptDccOffer(offer.network, offer.offer_id),
    },
    // The × is the REFUSAL, as on the invite — not the episode-scoped hide.
    // Labelled with the file, because several offers can be stacked and a
    // screen reader announcing "dismiss notification" would not say which
    // one is about to be thrown away.
    dismiss: {
      label: `Refuse the file ${offer.filename} from ${offer.from}`,
      onAction: () => refuseDccOffer(offer.network, offer.offer_id),
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
