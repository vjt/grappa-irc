import { patchNetwork, postPart } from "./api";
import { getSubject, token } from "./auth";
import { channelKey } from "./channelKey";
import { requestConfirm } from "./confirmDialog";
import { closeQueryWindowState } from "./queryWindows";
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
// #902 — `:invited` is NO LONGER one of these: it has no pseudo-row to
// dismiss, so there is no × here to route. #976 — nor is its refusal a PART.
// The invite banner's × calls `declineInvite` (channelJoin.ts), which DELETEs
// the invite resource; the server drops the `:invited` window and fans
// `window_invite_declined` out on the user topic. Same durability #511 won
// for the tab, reached by a different door on purpose: PARTing a channel you
// were never in is a 442 no-op whose only real effect is the server-side
// cleanup, and dressing a refusal up as a leave would make the decline
// inherit de-autojoin and `channels_changed` semantics it has no business
// with. Whatever you do, do not "unify" the two for consistency.
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
  // #1208 — a window close carries no reason: closing a tab is not a
  // statement to the channel. Explicit `null` keeps the wire frame the bare
  // `PART #chan` it has always been.
  void postPart(t, networkSlug, name, null);
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
// Sidebar.handleClosePseudo, where a per-surface divergence had grown:
// the mobile bar's raw setParted deferred to the bucket-E close-watcher
// while the Sidebar redirected to $server — same action, two navigations.
// INC-3 unified on the Sidebar's spelling to keep the change behaviour-
// free; #445 has since settled the target the other way (see below), so
// the surviving unification is the VERB, not the destination. #902 left
// the desktop Sidebar its only caller — the mobile BottomBar's sole
// pseudo-row was the `:invited` tab, and that is a banner now — but the
// verb stays HERE rather than moving back inline: it is a window-lifecycle
// verb, and the file it lives in is the one that owns the PART.
//
// #511 — the dismissal goes through the SAME `partAndForget` DELETE path
// `closeChannelWindow` uses, not a client-only `forceParted`. Pre-fix this
// dropped the local key only; the server kept `window_states[ch]` and the
// cold-subscribe snapshot re-asserted it on the next reload — the dismissed
// tab came back. The PART is a 442 no-op for the never-joined channel, but
// the server-side `set_parted` clears the key so the dismissal is durable.
// See the `partAndForget` doc above for why the PART, the `forceParted`,
// and the token guard are the right primitives — including why the invite
// banner takes its own DELETE door instead (#902 removed the row, #976 gave
// the refusal its own verb).
//
// #445 — this verb steers NO focus. INC-3 shipped an explicit "if the
// dismissed row is the focused window, go to $server" redirect here and
// deferred whether $server was the right destination; vjt ruled MRU. That
// ruling deletes code rather than replacing it: selection.ts's bucket-E
// close-watcher ALREADY resolves MRU → $server → home for every other
// close in the app (/part, a server-side kick, the /disconnect cascade, a
// query close), and it fires here too the moment `forceParted` drops the
// key — a pseudo-row is live to that watcher precisely because
// `windowIsPresent` says so (UX-7-E). The old redirect's only effect was
// to PRE-EMPT it, making the dismissal the one close that ignored MRU.
// Removing it leaves one owner of the close target, per CLAUDE.md "don't
// duplicate state — derive it".
//
// Do not re-add a redirect here, not even "to MRU": calling the picker
// from this side would duplicate the derivation AND fire for an unfocused
// row, stealing focus from a window the operator is looking at. The
// watcher is focus-gated by construction; this verb must not be.
export function dismissPseudoWindow(networkSlug: string, name: string): void {
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
    attachments: null,
    choice: null,
    defaultButton: "cancel",
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
    attachments: null,
    choice: null,
    defaultButton: "cancel",
  });
}
