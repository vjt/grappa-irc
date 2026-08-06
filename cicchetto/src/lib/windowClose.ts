import { patchNetwork, postPart } from "./api";
import { getSubject, token } from "./auth";
import { channelKey } from "./channelKey";
import { requestConfirm } from "./confirmDialog";
import { closeQueryWindowState } from "./queryWindows";
import { selectedChannel, setSelectedChannel } from "./selection";
import { SERVER_WINDOW_NAME } from "./windowKinds";
import { forceParted } from "./windowState";

// Shared close-window helpers. Two call sites today: Sidebar × on
// desktop, BottomBar × on mobile (iOS-3). Mirror the
// one-feature-one-code-path rule (CLAUDE.md): channel close goes through
// PART; query close drops the cic-side window row.
//
// #195 — the two DESTRUCTIVE closes (leave a channel → upstream PART;
// disconnect a network → park/quit) are gated behind an explicit confirm
// modal via `confirmLeaveChannel` / `confirmDisconnectNetwork` (below),
// replacing the removed #172 hold-to-close gesture. The raw verbs stay the
// on-confirm ACTION and remain the direct path for NON-destructive closes
// (query + pseudo windows, which just drop a local row and are trivially
// reopened — no confirm).

// #38, #71 INC-3, #511 — THE shared "close a channel-shaped window" verb:
// forward a PART upstream (the DELETE) AND drop the local windowState
// pseudo-projection. Both the × on a joined tab (`closeChannelWindow`) and
// the × on a greyed non-joined pseudo-row (`dismissPseudoWindow`) route
// through here so a close takes the SAME server-side path on every surface
// — one door (CLAUDE.md one-feature-one-code-path).
//
// The DELETE removes the channel from `channelsBySlug` (server de-autojoins
// + broadcasts `channels_changed` → refetch). For a channel the user never
// actually joined — a +k autojoin entry that 475'd on (re)connect, or a
// :failed / :kicked pseudo-row — the upstream PART is a 442 no-op, so NO
// self-PART scrollback echo arrives. But the server's
// `PartCleanup.cleanup_local` → `WindowState.set_parted` still drops the
// channel from EVERY window-state map. That is what makes a dismissal
// DURABLE: a client-only drop (the pre-#511 bug) let the cold-subscribe
// snapshot resurrect the row on the next reload; routing the × through the
// DELETE clears the server key so the snapshot stops re-asserting it.
//
// #902 — `:invited` is NO LONGER one of these. It has no pseudo-row to
// dismiss any more; an invite is a top banner whose × is deliberately
// session-scoped and writes NOTHING (vjt's ruling: an invite is allowed to
// be lost, and the peer can invite again). So a dismissed invite DOES come
// back after a reload, because `WindowState.invited_windows/2` still
// re-emits `window_invited` for every channel held at `:invited` — the exact
// behaviour #511 was filed to stop for the TAB, now intended for the BANNER.
// The difference is that a banner is a notification, not a window: nothing
// accumulates in the sidebar, so re-announcing it is cheap rather than the
// "dismissed tab came back" bug. `[Join]` (or a server-side clear) is what
// ends it for good.
//
// `forceParted` (not the echo's `setParted`): a × is a USER close, fresh
// intent, so it drops the local key even mid-`pending` — the #495
// stale-echo guard on `setParted` must NOT swallow a deliberate ×. Also the
// only window-state drop when the 442 no-op means no echo arrives; without
// it the non-`:joined` entry orphans into an un-dismissable greyed
// pseudo-row (`Sidebar.pseudoChannelsForNetwork`) once `channelsBySlug`
// drops the name. Idempotent with the echo for actually-joined channels;
// clearing (vs. adding) a key can only emit FEWER pseudo-rows.
//
// Token-guarded: with no token the whole op is a no-op — a local-only drop
// that never reaches the server is EXACTLY the #511 bug (row gone locally,
// resurrected on reload), so we do neither half.
function partAndForget(networkSlug: string, name: string): void {
  const t = token();
  if (!t) return;
  void postPart(t, networkSlug, name);
  forceParted(channelKey(networkSlug, name));
}

export function closeChannelWindow(networkSlug: string, channelName: string): void {
  partAndForget(networkSlug, channelName);
}

export function closeQueryWindow(networkId: number, targetNick: string): void {
  closeQueryWindowState(networkId, targetNick);
}

// #71 INC-3 — THE shared verb for dismissing a non-joined pseudo-row
// (pending/failed/kicked/parked) via its ×. Was previously inline in
// Sidebar.handleClosePseudo; the mobile bar's raw setParted let the
// bucket-E close-watcher pick MRU, a per-surface divergence the INC-3
// review caught. #902 left the desktop Sidebar its only caller — the mobile
// BottomBar's sole pseudo-row was the `:invited` tab, and that is a banner
// now — but the verb stays HERE rather than moving back inline: it is a
// window-lifecycle verb, and the file it lives in is the one that owns the
// PART.
//
// #511 — the dismissal goes through the SAME `partAndForget` DELETE path
// `closeChannelWindow` uses, not a client-only `forceParted`. Pre-fix this
// dropped the local key only; the server kept `window_states[ch]` and the
// cold-subscribe snapshot re-asserted it on the next reload — the dismissed
// tab came back. The PART is a 442 no-op for the never-joined channel, but
// the server-side `set_parted` clears the key so the dismissal is durable.
// See the `partAndForget` doc above for why the PART, the `forceParted`,
// and the token guard are the right primitives — including why #902's
// invite banner deliberately does NOT take this path.
//
// If the dismissed row IS the focused window, redirect to the network's
// $server window FIRST, pre-empting the bucket-E watcher (which would
// otherwise pick the most-recently-viewed window). $server-vs-MRU is a
// deferred product choice — see DESIGN_NOTES 2026-07-26 #71 INC-3 + the
// follow-up issue; today both surfaces land on $server. The redirect runs
// before `partAndForget`, so in the (unreachable in-UI) no-token case focus
// still moves to $server while the row stays put — harmless because a
// pseudo-row is never rendered without a token; revisit only if some
// token-expiry edge ever makes this path reachable.
export function dismissPseudoWindow(networkSlug: string, name: string): void {
  const sel = selectedChannel();
  if (sel !== null && sel.networkSlug === networkSlug && sel.channelName === name) {
    setSelectedChannel({ networkSlug, channelName: SERVER_WINDOW_NAME, kind: "server" });
  }
  partAndForget(networkSlug, name);
}

// UX-4 bucket D — close the server window for a network by PARKING it.
// #211 phase 6 — subject-agnostic: BOTH users and visitors PATCH the one
// network to `:parked` (ruling D — visitors carry a real per-network
// connection_state now, so a network-header × parks THAT network, not a
// nuclear quit-all). The user-topic `connection_state_changed` event
// then drives the cic side: networkBySlug refetches → the parked-cascade
// in Sidebar dims the network's rows, and the selection redirect in
// selection.ts shifts focus to home when the currently-selected window
// belongs to the parked network. A visitor's park PERSISTS across reboot
// (Bootstrap skips parked visitor credentials); a global disconnect-all
// is the separate `quit` verb.
//
// Selection redirect intentionally lives in selection.ts (not here) so
// the same redirect fires on /disconnect typed in the compose box AND
// on server-side circuit-breaker park events. Per CLAUDE.md "Don't
// duplicate state — derive it".
//
// PATCH failures are logged (no UI toast — the action is destructive
// and the next render either shows parked-cascade or the operator can
// retry). Mirror the `[/quit]` console.warn prefix used in `quit.ts`
// so operators have one grep-key for all park-path failures.
//
// Subject-undefined (post-logout race / poisoned localStorage that the
// auth.ts narrower cleared) takes the safe path: no-op + warn.
export function disconnectNetwork(networkSlug: string): void {
  const t = token();
  if (!t) return;
  const subject = getSubject();
  if (subject === null) {
    console.warn(
      `[/disconnect] no subject in localStorage for slug=${networkSlug}; skipping (token-without-subject race)`,
    );
    return;
  }
  void patchNetwork(t, networkSlug, { connection_state: "parked" }).catch((err) => {
    console.warn(`[/disconnect] PATCH park failed for network ${networkSlug}:`, err);
  });
}

// #195 — confirm-gated channel leave. The × on a channel tab opens an
// explicit "Do you want to leave <#channel>?" modal; Yes runs the PART via
// closeChannelWindow, Cancel dismisses. Non-destructive default (Cancel
// focused) so an accidental tap can't PART a channel — the exact regression
// #195 fixes (the #172 hold gate that silently swallowed touch taps is gone).
export function confirmLeaveChannel(networkSlug: string, channelName: string): void {
  requestConfirm({
    title: "Leave channel",
    body: `Do you want to leave ${channelName}?`,
    confirmLabel: "Yes",
    onConfirm: () => closeChannelWindow(networkSlug, channelName),
    alternative: null,
  });
}

// #195 — confirm-gated network disconnect. The × on a network-header row
// parks that ONE network (both subjects, phase 6), so it gets an explicit
// "Disconnect from <slug>?" modal before firing disconnectNetwork.
export function confirmDisconnectNetwork(networkSlug: string): void {
  requestConfirm({
    title: "Disconnect network",
    body: `Disconnect from ${networkSlug}?`,
    confirmLabel: "Yes",
    onConfirm: () => disconnectNetwork(networkSlug),
    alternative: null,
  });
}
