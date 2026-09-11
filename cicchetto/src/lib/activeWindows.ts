import { createMemo, untrack } from "solid-js";
import { type ChannelKey, channelKey } from "./channelKey";
import { isConversationMuted, windowMuteKey } from "./conversationMute";
import { requestJumpToUnread } from "./jumpToUnreadCommand";
import { mentionCounts } from "./mentions";
import { moduleRoot } from "./moduleRoot";
import { channelsBySlug, networks } from "./networks";
import { notificationPrefs } from "./notificationPrefs";
import { queryWindowsByNetwork } from "./queryWindows";
import { farBehindByChannel, scrollbackByChannel } from "./scrollback";
import { requestScrollToBottom } from "./scrollToBottomCommand";
import {
  isActiveSelection,
  messagesUnread,
  selectedChannel,
  setSelectedChannel,
} from "./selection";
import type { MutedTargets } from "./userSettings";

// GH #235 — "jump to next active window" (irssi Alt+A).
//
// A single derivation that answers "which windows have unread activity,
// and in what order do we cycle through them?" — reused by the Alt+A
// keybinding, the on-screen affordance button (BottomBar-right on
// mobile / sidebar-bottom-left on desktop), AND the pre-existing
// Ctrl+N / Ctrl+P next/prev-unread verbs. ONE ordering, one code path,
// every door (CLAUDE.md "reuse the verbs, not the nouns").
//
// Prior art it REPLACES: Shell.tsx's inline `nextUnread`/`prevUnread`
// walked `flatChannels` in SIDEBAR order, EXCLUDED query (DM) windows,
// and had no priority tiers. #235 requires the opposite — DMs + mentions
// FIRST, chronological within a tier — so the ordering is extracted here
// as one pure fn and the two existing verbs re-point at it (a strict
// upgrade: they now reach DMs and honour tiers too).
//
// State is DERIVED, never duplicated (CLAUDE.md): unread activity comes
// from `selection.messagesUnread`, the mention tier from `mentions`, the
// query tier from `queryWindowsByNetwork`, and the per-window activity
// timestamp from the newest local scrollback row id. cic originates no
// parallel activity store.
//
// #265 — the activity gate is MESSAGE-scoped (`messagesUnread`, the
// content kinds PRIVMSG/NOTICE/ACTION via `api.CONTENT_KINDS`), NOT the
// TOTAL (`unreadCounts` = messages + events). Presence churn — JOIN /
// PART / QUIT / NICK / MODE / TOPIC / KICK — is real activity for the
// per-window `.sidebar-events-unread` badge but noise for "which window
// has something worth reading?", so it does NOT light the affordance.
// One source (`messagesUnread`), one gate, every door: the count, Alt+A,
// Ctrl+N/P and the auto-hide all inherit it. The per-window sidebar /
// bottom-bar badges keep rendering `messagesUnread` + `eventsUnread`
// separately — they are unaffected.

export type ActiveWindow = {
  networkSlug: string;
  channelName: string;
  kind: "channel" | "query";
};

export type OrderInput = {
  /**
   * All candidate windows in stable flat (sidebar) order — network
   * order, then channels then queries within each network. Used both as
   * the membership universe and as the final tie-break order.
   */
  candidates: ActiveWindow[];
  /**
   * Per-window message-scoped unread (content kinds PRIVMSG/NOTICE/ACTION
   * via `selection.messagesUnread`) — the activity gate. #265: presence
   * churn (JOIN/PART/QUIT/NICK/MODE/TOPIC/KICK) is EXCLUDED, so a window
   * with only join/part noise or a mode flip never lights the affordance.
   */
  unread: Record<ChannelKey, number>;
  /** Per-window mention/highlight count — promotes a channel to tier 0. */
  mentions: Record<ChannelKey, number>;
  /**
   * Per-window activity timestamp: the newest local scrollback row id
   * (monotonic sqlite PK, globally ordered across windows). 0 for a
   * seed-only window (unread carried over from before this session with
   * no local rows yet) — correctly the "oldest" activity.
   */
  activityId: Record<ChannelKey, number>;
  /**
   * The subject's muted conversations (#866), as the READER hands them over
   * — `notificationPrefs()` has already dropped elapsed snoozes, so an
   * entry present here silences and no clock is consulted below. #1018: a
   * muted window is not a stop on the cycle. `undefined` (a BEAM older than
   * this bundle) means "no mutes".
   *
   * Required, not optional: a door that forgets the mute is a compile error
   * rather than a window that silently keeps stealing the jump.
   */
  muted: MutedTargets | undefined;
};

// Tier-0 predicate: a window is "priority" when it is a query (DM) OR
// carries a mention/highlight. The single source of truth for the tier
// distinction, shared by `orderUnreadWindows` (tier assignment) and
// `classifyNextActive` (#280 badge color) so the two can never diverge —
// derive, don't duplicate (CLAUDE.md).
export function isPriorityWindow(w: ActiveWindow, mentions: Record<ChannelKey, number>): boolean {
  const key = channelKey(w.networkSlug, w.channelName);
  return w.kind === "query" || (mentions[key] ?? 0) > 0;
}

// Pure ordering. Filter to windows with unread activity that the operator
// has not muted, then sort:
//   1. tier — mention/highlight OR query (DM) come first (0), ordinary
//      channel traffic second (1);
//   2. activity time ascending — chronological, oldest activity first
//      (clear your backlog in the order it arrived);
//   3. flat (sidebar) index — stable tie-break for equal activity ids
//      (e.g. two seed-only windows).
export function orderUnreadWindows(input: OrderInput): ActiveWindow[] {
  const { candidates, unread, mentions, activityId, muted } = input;
  const ranked = candidates
    .map((w, flatIndex) => {
      const key = channelKey(w.networkSlug, w.channelName);
      return {
        window: w,
        unread: unread[key] ?? 0,
        tier: isPriorityWindow(w, mentions) ? 0 : 1,
        activityId: activityId[key] ?? 0,
        muted: isConversationMuted(muted, windowMuteKey(w)),
        flatIndex,
      };
    })
    // #1018 — the mute drops the window from the CYCLE, and it beats the
    // tier: a mention inside a muted room is still not a stop (#866 Q2,
    // "the mute always wins"). The COUNTS are untouched — the badges still
    // render, still show the same numbers, and the window still sits in the
    // sidebar. #1077 revised #866 Q4 on one axis only: those badges now
    // render DIMMED (`WindowBadges.MUTED_CLASS`, same predicate as here), a
    // visual weight change and nothing else.
    .filter((r) => r.unread > 0 && !r.muted);

  ranked.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.activityId !== b.activityId) return a.activityId - b.activityId;
    return a.flatIndex - b.flatIndex;
  });

  return ranked.map((r) => r.window);
}

// #280 — the "next" badge color reflects the KIND of the highest-priority
// pending window (the ordered-list HEAD, since orderUnreadWindows sorts
// tier-0 first): "priority" (RED) when that window is a query (DM) or
// carries a mention, "normal" (BLUE) when it is an ordinary channel, null
// when nothing is pending. Pure: takes the already-ordered list + the same
// mention map, so it can never disagree with the ordering / auto-hide.
export type NextActiveKind = "priority" | "normal";

export function classifyNextActive(
  ordered: ActiveWindow[],
  mentions: Record<ChannelKey, number>,
): NextActiveKind | null {
  const head = ordered[0];
  if (!head) return null;
  return isPriorityWindow(head, mentions) ? "priority" : "normal";
}

// Flat candidate list mirroring the sidebar/bottom-bar window order:
// per network, channels then queries. Server / home / admin / list /
// mentions windows are intentionally excluded — #235 cycles
// "channel/query" windows only (server status buffers aren't activity
// windows in the irssi sense).
//
// Exported since #866: the per-conversation mute picker offers exactly the
// conversations the sidebar shows, and the alternative was a second
// walk over `networks()` × `channelsBySlug()` × `queryWindowsByNetwork()`
// that would drift from this one the first time a window shape is added.
export function windowCandidates(): ActiveWindow[] {
  const out: ActiveWindow[] = [];
  const cbs = channelsBySlug() ?? {};
  const qwbn = queryWindowsByNetwork();
  for (const net of networks() ?? []) {
    for (const ch of cbs[net.slug] ?? []) {
      out.push({ networkSlug: net.slug, channelName: ch.name, kind: "channel" });
    }
    for (const qw of qwbn[net.id] ?? []) {
      out.push({ networkSlug: net.slug, channelName: qw.targetNick, kind: "query" });
    }
  }
  return out;
}

// Per-window activity id = newest local scrollback row id. Rows are ASC
// by (server_time, id), so the last element is the newest. A window with
// no local rows (seed-only unread) is absent from the map → treated as 0
// (oldest) by `orderUnreadWindows`.
function buildActivityIds(): Record<ChannelKey, number> {
  const out: Record<ChannelKey, number> = {};
  for (const [rawKey, rows] of Object.entries(scrollbackByChannel())) {
    const last = rows[rows.length - 1];
    if (last) out[rawKey as ChannelKey] = last.id;
  }
  return out;
}

// Reactive, memoised ordered list of windows with unread activity.
// Consumed reactively by the affordance button (visibility + count) and
// untracked by the jump verbs. Wrapped in createRoot so the memo has an
// owner (module-singleton, never disposed) — mirrors queryWindows.ts.
const root = moduleRoot(() => {
  const activeWindows = createMemo((): ActiveWindow[] =>
    orderUnreadWindows({
      candidates: windowCandidates(),
      unread: messagesUnread(),
      mentions: mentionCounts(),
      activityId: buildActivityIds(),
      // #1018 — read through `notificationPrefs()`, never the stored signal:
      // that reader resolves an elapsed snooze, so a mute that ran out puts
      // its window back on the cycle with no clock handling here.
      muted: notificationPrefs().muted_targets,
    }),
  );
  return { activeWindows };
});

export const activeWindows = root.activeWindows;

export const hasActiveWindows = (): boolean => activeWindows().length > 0;

export const activeWindowCount = (): number => activeWindows().length;

// #280 — reactive badge KIND for the on-screen affordance. Reads the same
// live signals as the count / auto-hide (activeWindows + mentionCounts),
// so the color is derived from ONE source and can never drift. Returns
// null when nothing is pending (button auto-hidden anyway). #267's
// client→server mention-counter migration is orthogonal (the color needs
// the target's KIND, not the count's provenance) — deferred to #267.
export const nextActiveKind = (): NextActiveKind | null =>
  classifyNextActive(activeWindows(), mentionCounts());

// Advance selection to the next (dir = 1) or previous (dir = -1) window
// with unread activity, wrapping. Untracked: callers are event handlers
// (keydown, button click), not reactive scopes — reading the signals
// here must not subscribe them.
function stepActiveWindow(dir: 1 | -1): void {
  const list = untrack(activeWindows);
  if (list.length === 0) return;
  const sel = untrack(selectedChannel);
  const curIdx = sel
    ? list.findIndex((w) => w.networkSlug === sel.networkSlug && w.channelName === sel.channelName)
    : -1;
  // When the current selection isn't in the unread list (not selected,
  // or just read → dropped out), start so the first step lands on the
  // first (next) or last (prev) window.
  const start = curIdx === -1 ? (dir === 1 ? -1 : 0) : curIdx;
  const nextIdx = (start + dir + list.length) % list.length;
  const target = list[nextIdx];
  if (!target) return;
  const next = {
    networkSlug: target.networkSlug,
    channelName: target.channelName,
    kind: target.kind,
  };
  // #1178 — the cycle can resolve to the window the operator is already
  // in: one unread window, and it is this one. That happens exactly when
  // they are scrolled back with unread below them (the read-at-the-tail
  // suppression in selection.ts only drops the selected window from the
  // list once the pane is AT the tail), which is the moment they most
  // want the jump. Handing that to `setSelectedChannel` is a
  // non-transition it short-circuits, so the badge said "1" and nothing
  // moved.
  //
  // The unread is not unreachable, it is BELOW: the jump is vertical
  // rather than lateral. So take the #243 exit — the same
  // `requestScrollToBottom` a re-tap on the already-active Sidebar row /
  // BottomBar tab fires — which also advances the read cursor (#310), so
  // the count that advertised the jump actually falls.
  //
  // NOT hidden and NOT disabled: there IS unread and it IS reachable, and
  // `»` is the only jump affordance on mobile (#235). Hiding it in the
  // one state where the operator wants it trades a lying button for an
  // absent one, and would put `activeWindowCount()` at odds with the
  // sidebar badges counting the same windows.
  //
  // NOT #693's `jumpToUnread` either: that verb is far-behind-only
  // (`farBehindByChannel[key]` or it returns false), so in the reported
  // state — scrolled back a few screens — it would leave the button just
  // as dead; and in the state where it does apply, the pane already
  // renders #693's own in-pane "N unread — jump back" affordance.
  //
  // The predicate is `isActiveSelection`, not a local compare: it is the
  // exact negation of the setter's short-circuit (both route through
  // `sameSelection`), so this arm cannot drift from the non-transition
  // rule that makes it necessary.
  //
  // #1765 — the sentence above names its own boundary, and the boundary
  // turned out to be a hole. `requestScrollToBottom` reaches the cursor
  // ONLY through `setCursorIfAdvances`, which returns on its first line for
  // a far-behind window (#693's freeze, #1019's invariant). So on a window
  // that IS far behind, #1178's exit is as dead as the `jumpToUnread` it
  // rejected — two correct cures cancelling — and the tap moves nothing at
  // all: the far-behind count cannot fall (the record's own `missed` since
  // #2037, the seed before it), so the button cannot hide.
  //
  // The two verbs partition the state exactly along `farBehindByChannel`,
  // and the comment above already says why each is dead on the other's
  // side. So take the live one: far behind ⇒ the bar's OWN primary exit,
  // the jump BACK into the unread region.
  //
  // NOT the bar's `×` (`dismissFarBehind`), which the report proposed.
  // That verb accepts the abandoned region as read — irreversible, fanned
  // to every device — and #1062 already ruled on putting it under this
  // thumb: it removed #997's second dismiss surface from the very float
  // stack this button lives in, on the grounds that "the far-behind gesture
  // stays on the bar, where it has a label". `»` carries no label but
  // "jump to next active window", and the count it shows is a WINDOW count
  // (1), so a tap would destroy thousands of unread while reading `»1`.
  // The jump is reversible (scroll back down / `loadNewer`) and is what the
  // glyph promises; the destructive exit stays one labelled tap away on the
  // bar. Duplicating a non-destructive route is harmless — duplicating a
  // destructive one is what #1062 measured and removed.
  //
  // A nonce rather than a direct `scrollback.jumpToUnread` call for the
  // same reason #243 is one: the #168 marker-activation latch the gesture
  // must arm is pane-local. See `jumpToUnreadCommand`.
  if (isActiveSelection(next)) {
    if (untrack(farBehindByChannel)[channelKey(next.networkSlug, next.channelName)]) {
      requestJumpToUnread();
    } else {
      requestScrollToBottom();
    }
    return;
  }
  setSelectedChannel(next);
}

export const jumpToNextActiveWindow = (): void => stepActiveWindow(1);

export const jumpToPrevActiveWindow = (): void => stepActiveWindow(-1);
