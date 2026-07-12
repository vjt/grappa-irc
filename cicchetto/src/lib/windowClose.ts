import { patchNetwork, postPart } from "./api";
import { getSubject, token } from "./auth";
import { channelKey } from "./channelKey";
import { requestConfirm } from "./confirmDialog";
import { closeQueryWindowState } from "./queryWindows";
import { setParted } from "./windowState";

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

export function closeChannelWindow(networkSlug: string, channelName: string): void {
  const t = token();
  if (!t) return;
  void postPart(t, networkSlug, channelName);
  // #38 — also clear the local windowState pseudo-projection. The DELETE
  // removes the channel from `channelsBySlug` (server de-autojoins +
  // broadcasts `channels_changed` → refetch), but for a channel the user
  // never actually joined — e.g. a +k autojoin entry that 475'd on
  // (re)connect — the upstream PART is a 442 no-op, so NO self-PART
  // scrollback echo arrives. That echo (subscribe.ts) is the ONLY thing
  // that calls `setParted`, so without clearing it here the non-`:joined`
  // windowState entry is orphaned and re-emerges as an un-dismissable
  // greyed pseudo-row (`Sidebar.pseudoChannelsForNetwork`) the instant
  // `channelsBySlug` drops the name. `setParted` is idempotent with the
  // echo for actually-joined channels, and clearing (vs. adding) a
  // windowState key can only emit FEWER pseudo-rows — the opposite
  // direction from the reverted PHASE-1.1 ghost-row regression.
  setParted(channelKey(networkSlug, channelName));
}

export function closeQueryWindow(networkId: number, targetNick: string): void {
  closeQueryWindowState(networkId, targetNick);
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
  });
}
