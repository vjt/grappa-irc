// UX-6-J — push notification deep-link routing on the cic side.
//
// Pre-J: tapping an OS push notification ran the SW's
// `notificationclick` handler, which called `existing.navigate(url)`
// on the focused client. cic is an SPA — every route resolves to
// `index.html`, selection state lives in the `selectedChannel` signal
// (not the router), so `navigate(url)` reloaded the SPA at `/` and
// the deep-link query params (`?network=…&channel=…`) were ignored.
// vjt iPhone-dogfood Bug 10: tap a push for #sniffo while focused on
// home → returned to home, not #sniffo.
//
// J: split the responsibility. The SW posts `{type: "navigate", url}`
// to the focused client AFTER `focus()`; this module installs the
// listener, parses the URL via `parsePushTargetUrl`, and calls
// `setSelectedChannel`. The existing selection-store machinery
// (`subscribe.ts` join effects, scrollback backfill, badge clear)
// fires automatically off the signal change. No router involvement,
// no SPA reload — the same code path as a sidebar click.
//
// `applyPushTargetFromUrl` covers the cold-path case: SW called
// `openWindow(url)` on a not-yet-running client. The URL ships the
// deep-link params; this helper reads `location.search` at boot and
// applies the same routing. Deferred until networks() seed so the
// selection doesn't fire on a still-loading store.

import { createEffect, untrack } from "solid-js";
import { encryptedChat, encryptedChatNick } from "./encryptedChats";
import { openEncryptedWindow } from "./encryptedWindow";
import { parseInviteLinkUrl, routeInviteTarget } from "./inviteLink";
import { moduleRoot } from "./moduleRoot";
import { channelsBySlug, networkBySlug, networks } from "./networks";
import { type PushTarget, parsePushTargetUrl } from "./pushPayload";
import { canonicalQueryNick, openQueryWindowState } from "./queryWindows";
import { type SelectedChannel, setSelectedChannel } from "./selection";
import { encryptedWindowName } from "./windowKinds";

/**
 * Routes a parsed push target into the selection store.
 *
 * #146 — a DM (query) target MUST be OPENED before it can be focused.
 * `setSelectedChannel` alone selects a window that may not exist yet: the
 * server never auto-creates a `query_windows` row for an inbound DM (only
 * cic's `open_query_window` push does), so a DM notification tapped when
 * no query window exists — cold load after a DM-while-closed, or a warm
 * client that never opened that DM — produced a dead selection with no
 * sidebar row. Reuse the same open-then-select verb every other DM-open
 * site uses (compose `/msg` `/query`, NamesModal, UserContextMenu,
 * subscribe.ts inbound-DM): resolve the network, canonicalise the nick,
 * `openQueryWindowState` (server upserts the row + broadcasts
 * `query_windows_list`, which renders it), then select.
 *
 * Channels need no open step — a highlight implies the operator is already
 * joined, so the channel is already in `channelsBySlug`.
 *
 * An encrypted message (issue 2515) opens the encrypted query with the
 * nick, never the plaintext one: through `openEncryptedWindow`, the
 * open-then-focus verb `/equery` and the nick menu use. Opening is what
 * makes the window exist on a device that has not drained the message yet
 * (a cold tap); the drain then fills it. The nick is the one the device's
 * chat index stores (`encryptedChatNick`), read off the store because on a
 * cold tap the page's copy is not in yet: an open under the wire's spelling
 * would rename a chat the user named otherwise. It is async and fires from a
 * tap, so a failure is said, not thrown.
 *
 * Shared by both push-target call sites (warm `applyPushTarget`, cold
 * `deferUntilNetworksSeed`) so the open-then-select contract can't drift
 * between them.
 */
function routePushTarget(target: PushTarget): void {
  if (target.kind === "encrypted") {
    const { networkSlug, channelName } = target;
    void encryptedChatNick(networkSlug, channelName)
      .then((nick) => openEncryptedWindow(networkSlug, nick))
      .catch((err: unknown) => {
        console.warn(`pushTarget: could not open the encrypted query with ${channelName}`, err);
      });
    return;
  }
  const selection = pushTargetSelection(target);
  if (selection.kind === "query") {
    const net = networkBySlug(target.networkSlug);
    // Network not resolvable (stale deep-link to an unbound network): no
    // query window to open, and `pushTargetSelection` has already fallen
    // back to the raw nick. The select below is still best-effort — the
    // selection store's bucket-E picker only fires on a was-live→not-live
    // transition, so a fresh not-live selection is not clobbered.
    if (net !== undefined) {
      openQueryWindowState(net.id, selection.channelName, new Date().toISOString());
    }
  }
  setSelectedChannel(selection);
}

/**
 * THE push-target → window-identity mapping, shared by the two directions
 * a notification travels (#2034).
 *
 * `routePushTarget` walks it forwards (a tapped notification names the
 * window to focus); `notificationDismiss.ts` walks it backwards (an OPEN
 * notification is asked whether it names the window already focused). Both
 * must agree on what "the same window" means, so the canonicalisation lives
 * here once rather than being spelled twice.
 *
 * The mapping is not the identity function, and that is the whole reason
 * this is extracted rather than inlined. A DM payload carries the peer nick
 * RAW as the server saw it on the wire (`Push.Payload.build/3` uses
 * `sender`, per the key/display split), while the selection store holds the
 * CANONICAL nick — whatever spelling the open query window already uses.
 * `Alice` on the wire is the window `alice`, and a byte compare of the two
 * answers "different window" for the very notification the reader is
 * looking at.
 *
 * Channels need no step here, and the reason is worth stating precisely,
 * because the obvious one is wrong for half the callers (review,
 * 2026-09-10). It is NOT that `setSelectedChannel` folds the channel KEY on
 * the way in — it does (`foldChannelKey`, #1396), but only the FORWARD path
 * reaches the setter; the backward path never calls it. What covers BOTH
 * directions is `isActiveSelection`, which runs its own argument through the
 * same `foldChannelKey` before comparing. So the fold that makes this
 * function safe to skip for channels lives in `selection.ts`'s comparator,
 * not in its setter — removing it there would silently break the dismissal
 * while every forward-path test stayed green.
 *
 * An encrypted message names the encrypted query `$e2e:<nick>` (issue
 * 2515), with the nick as the page's copy of the chat index spells it: the
 * name the window's sidebar row carries, the twin of the query branch's
 * canonical nick. Only the backward walk reads it here, and a window in view
 * is in that copy; the forward walk reads the store (see `routePushTarget`).
 *
 * Total: an unresolvable network yields the raw name rather than null, so
 * a stale deep-link degrades to a best-effort match instead of a crash.
 */
export function pushTargetSelection(target: PushTarget): NonNullable<SelectedChannel> {
  if (target.kind === "encrypted") {
    return {
      networkSlug: target.networkSlug,
      channelName: encryptedWindowName(
        encryptedChat(target.networkSlug, target.channelName)?.nick ?? target.channelName,
      ),
      kind: "encrypted",
    };
  }
  if (target.kind === "query") {
    const net = networkBySlug(target.networkSlug);
    if (net !== undefined) {
      return {
        networkSlug: target.networkSlug,
        channelName: canonicalQueryNick(net.id, target.channelName),
        kind: "query",
      };
    }
  }
  return {
    networkSlug: target.networkSlug,
    channelName: target.channelName,
    kind: target.kind,
  };
}

/**
 * Resolves a push-target URL and routes selection. Returns true if the
 * target was routed, false on parse failure. An encrypted target (issue
 * 2515) is routed to an async open: true says the open was asked for, not
 * that the window is up yet; its failure goes to the console.
 *
 * Pure wrt the selection store — caller responsibility to invoke from
 * a context where setSelectedChannel side-effects are appropriate
 * (boot, post-network-seed, or SW message handler).
 *
 * Parse failures `console.warn` (per `feedback_no_silent_drops_*`):
 * a future malformed-payload bug should surface in devtools rather
 * than degrade silently to "click did nothing".
 */
export function applyPushTarget(rawUrl: string): boolean {
  const target = parsePushTargetUrl(rawUrl);
  if (target === null) {
    console.warn("pushTarget: URL parse failed", rawUrl);
    return false;
  }
  routePushTarget(target);
  return true;
}

/**
 * Wires the SW → client `message` channel. The SW posts
 * `{type: "navigate", url}` from its `notificationclick` handler;
 * this listener filters non-navigate messages and routes through
 * `applyPushTarget`.
 *
 * No-op when `navigator.serviceWorker` is absent (test envs without
 * SW polyfills, browsers with SW disabled). Matches the same
 * defensive shape as `lib/socket.ts`'s navigator-feature checks.
 *
 * Mounted at boot from `main.tsx`. Single global listener — the SW
 * matchAll fans out posts to every controlled client, but in practice
 * there's only one open cic tab per user-agent at any time (the PWA
 * shape).
 */
export function installPushTargetListener(): void {
  if (typeof navigator === "undefined") return;
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (ev: MessageEvent) => {
    const data = ev.data;
    if (typeof data !== "object" || data === null) return;
    const { type, url } = data as { type?: unknown; url?: unknown };
    if (type !== "navigate") return;
    if (typeof url !== "string") return;
    applyPushTarget(url);
  });
}

/**
 * THE boot-time deep-link reader — one reader, two URL shapes.
 *
 * Cold-path push (UX-6-J): when the SW opens a fresh window via
 * `openWindow(url)`, the URL ships the deep-link params but there's
 * no message-to-listener handshake (the page hasn't installed the
 * listener yet at openWindow time). Read `location.href` at boot,
 * defer the selection until `networks()` seeds — without the wait,
 * setSelectedChannel fires against an empty store and the UX-4
 * bucket E / D effects can't validate against the live data.
 *
 * Wrapped in `createRoot` because `main.tsx` calls this BEFORE
 * `render()`, and Solid's `createEffect` outside a reactive owner
 * warns + never disposes. The root is intentionally never disposed
 * — the cold-path effect is module-singleton and one-shot.
 *
 * Test seam (`__cicPushTargetApplied`): the e2e cold-path spec sets
 * an assertion on this flag so it doesn't pass for the wrong reason
 * (e.g. a session-restore code path that selected the same channel
 * independently). Pure dev/test signal — production code ignores it.
 * For an encrypted target it marks the open as asked for, as
 * `applyPushTarget`'s true does: the window comes up when the open settles.
 *
 * Residual: the deep-link params are cleared from the URL bar via
 * `history.replaceState({}, "", "/")` after the selection lands.
 * Prevents a refresh from re-triggering the cold-path read against
 * a stale deep-link, and keeps the URL clean for share-link
 * ergonomics. The selection store's UX-5 BU tuple-equality
 * short-circuit means a re-fire would no-op anyway, but cleaning
 * the URL removes the question entirely.
 *
 * Invite link (#793): the second shape, `?go=<network>/<channel>`,
 * read by `lib/inviteLink.ts` into the SAME `PushTarget` and deferred
 * by the SAME mechanism. Both shapes are now query params on the same
 * URL, which is what makes "one reader, two shapes" literally true
 * rather than a figure of speech. What differs is only what the target
 * DOES on arrival — a confirm-then-join instead of a selection. The two
 * cannot co-occur meaningfully; a push payload wins, since it carries
 * an explicit notification the operator just tapped.
 */
export function applyDeepLinkFromUrl(): void {
  if (typeof window === "undefined" || !window.location) return;

  const push = parsePushTargetUrl(window.location.href);
  if (push !== null) {
    deferUntilReady({
      target: push,
      route: routePushTarget,
      // A push target names a channel the operator is already in, so the
      // routing needs the live list — an empty store cannot resolve it.
      ready: () => {
        const nets = networks();
        return nets !== undefined && nets.length > 0;
      },
      flag: "__cicPushTargetApplied",
    });
    return;
  }

  // #793 — the same reader, second URL shape: `?go=<network>/<channel>`.
  //
  // No early URL clean, unlike the path form this replaced. That clean existed
  // because a two-segment path matched no route, so leaving it in the address
  // bar across `render()` mounted the app on nothing; `?go=` sits on `/`, a
  // real route, so the router is content and `deferUntilReady`'s own
  // post-routing clean is the only one needed. One cleaning site, and the
  // invite stays legible in the address bar for as long as it is still
  // pending.
  const invite = parseInviteLinkUrl(window.location.href);
  if (invite === null) return;
  deferUntilReady({
    target: invite,
    route: routeInviteTarget,
    // Waits on the CHANNEL LIST, not on `networks()`, because that is the
    // source the invite route actually reads to decide whether we are
    // already in the channel. `channelsBySlug` is keyed on `networks`, so it
    // resolves strictly LATER — firing on the earlier signal read an
    // unresolved list, concluded "not in it", and asked for consent to join
    // a channel the operator was already sitting in (caught by the #793 e2e,
    // which is why that spec exists).
    //
    // RESOLVED, not non-empty: a recipient with nothing bound still gets an
    // answer (the not-bound notice) instead of silence. Unauthenticated, the
    // resource never resolves at all, so the invite simply waits out the
    // login round-trip and applies once the session is up.
    ready: () => channelsBySlug() !== undefined,
    flag: "__cicInviteLinkApplied",
  });
}

declare global {
  interface Window {
    __cicPushTargetApplied?: boolean;
    __cicInviteLinkApplied?: boolean;
  }
}

type DeepLink = {
  target: PushTarget;
  route: (target: PushTarget) => void;
  // Reads whatever store the route depends on; the effect tracks it, so each
  // deep-link shape declares its OWN readiness rather than sharing one that
  // happens to fit the older caller.
  ready: () => boolean;
  flag: "__cicPushTargetApplied" | "__cicInviteLinkApplied";
};

function deferUntilReady(link: DeepLink): void {
  let applied = false;
  moduleRoot(() => {
    createEffect(() => {
      if (applied) return;
      if (!link.ready()) return;
      applied = true;
      // `untrack`: the routing reads several stores, and none of them should
      // become a dependency of the gate — the one-shot `applied` flag makes a
      // re-run harmless, but a gate that re-fires on unrelated traffic is a
      // gate nobody can reason about.
      untrack(() => link.route(link.target));
      if (typeof window !== "undefined") {
        window[link.flag] = true;
        if (window.history && window.location) {
          window.history.replaceState({}, "", "/");
        }
      }
    });
  });
}
