import { patchNetwork, postPart } from "./api";
import { getSubject, token } from "./auth";
import { closeQueryWindowState } from "./queryWindows";
import { quitAll } from "./quit";

// Shared close-window helpers. Two call sites today: Sidebar × on
// desktop, BottomBar × on mobile (iOS-3). Mirror the
// one-feature-one-code-path rule (CLAUDE.md): channel close goes through
// PART; query close drops the cic-side window row.

export function closeChannelWindow(networkSlug: string, channelName: string): void {
  const t = token();
  if (!t) return;
  void postPart(t, networkSlug, channelName);
}

export function closeQueryWindow(networkId: number, targetNick: string): void {
  closeQueryWindowState(networkId, targetNick);
}

// UX-4 bucket D — close the server window for a network. Visitor
// branches to quitAll (nuclear: park-all + logout, per the plan-doc
// 2026-05-18 §"Bucket D — visitor: equivalent to /quit"). Registered
// user PATCHes the one network to :parked; the user-topic
// `connection_state_changed` event then drives the cic side:
// networkBySlug refetches → the parked-cascade in Sidebar dims the
// network's rows, and the selection redirect in selection.ts shifts
// focus to home when the currently-selected window belongs to the
// parked network.
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
// auth.ts narrower cleared) takes the safe path: no-op + warn. Pre-fix
// the bare `subject?.kind === "visitor"` check fell through to the
// registered PATCH, which 403s for a token whose subject is a visitor
// — silent 4xx (`feedback_no_silent_drops_closed`). When in doubt,
// log and bail rather than fire a request that can't succeed.
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
  if (subject.kind === "visitor") {
    void quitAll(null);
    return;
  }
  void patchNetwork(t, networkSlug, { connection_state: "parked" }).catch((err) => {
    console.warn(`[/disconnect] PATCH park failed for network ${networkSlug}:`, err);
  });
}
