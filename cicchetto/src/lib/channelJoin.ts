import { deleteInvite, patchNetwork, postJoin } from "./api";
import { token } from "./auth";
import { canonicalChannel, channelKey } from "./channelKey";
import { requestConfirm } from "./confirmDialog";
import { errorMessage } from "./friendlyApiError";
import { identityMoved } from "./identityMoved";
import { identityScopedStore } from "./identityScopedStore";
import { hasNoLiveSession } from "./networkSession";
import { networkBySlug } from "./networks";
import { setSelectedChannel } from "./selection";
import { createToastQueue } from "./toasts";
import { windowStateByChannel } from "./windowState";

// #648 — the verb behind a click-to-join `#channel` affordance rendered in
// scrollback (linkify.ts `channel` segment → MircText.renderChannel). It is a
// thin COMPOSITION of verbs that already exist — it opens no new socket call
// and holds no parallel state:
//
//   * joinChannel         — THE join verb (issue 2719, below), shared with
//                           compose.ts `/join`, DirectoryPane row taps and
//                           HomePane's featured links.
//   * setSelectedChannel  — the ONLY cic-originated focus origin (#244): the
//                           tap. Automatic re-joins never steal focus.
//   * windowStateByChannel — the server-owned window_states projection, the
//                           already-joined source of truth.
//   * requestConfirm      — the shared confirm-modal store (#195), the sibling
//                           of windowClose.ts's confirmLeaveChannel.
//
// The confirm gate is the 20% that differs from a DirectoryPane row tap: a
// `#channel` in prose is NOT an unambiguous join intent (a row tap is), so a
// scrollback click asks first — UNLESS we're already in the channel, where a
// confirm to "join" a window that's already open is noise (#648): switch to it
// directly.
//
// Casing split, mirroring compose.ts `/join` (#510/#516/#525): the JOIN goes on
// the wire RAW/display-cased (`#Sniffo` — the server does its own casemapping);
// focus + the already-joined lookup use the FOLDED key (`canonicalChannel` /
// `channelKey`, which folds internally), because window_states + selection are
// keyed folded — a mixed-case focus target opens a phantom window.

// Exported for #793's invite-link route, which reaches the already-in-the-
// channel outcome from a URL instead of a tap and must not grow a second
// spelling of "focus this channel window".
export function switchToChannelWindow(networkSlug: string, rawChannel: string): void {
  setSelectedChannel({
    networkSlug,
    channelName: canonicalChannel(rawChannel),
    kind: "channel",
  });
}

// issue 2719 — THE join verb: every door that joins a channel goes through it.
// It has four callers: `performJoin` below (behind the #648 confirm, the
// invite link, an invite row's [Join] and the invite banner), a DirectoryPane
// row tap, a HomePane featured link, and compose's `/join`. Each used to own a
// private copy of "POST the join, then focus the folded key", and the step
// they all lacked is the reason this exists:
//
// A JOIN sent to a network with no session answers 404 `not_found` (S14 folds
// `:no_session` into it) and opens nothing. The store already knows when that
// is (`hasNoLiveSession`: parked or failed), so the verb reconnects first. The
// two calls need no wait between them: the PATCH spawns the session before it
// answers (it writes `connected` only on spawn success), and the server holds a
// JOIN that arrives before 001 until 001 (issue 2114), opening the window
// `:pending` at once.
//
// Whether the reconnect needs a yes is the DOOR's question, not the verb's. A
// tap on a channel row is the intent, and Reconnect never had a modal (#1331).
// The #648 confirm asks one question that names both (`confirmJoinChannel`).
//
// Throws what the PATCH or the POST throws, and each door owns its own sink:
// the toast below, a directory row's inline line, a featured link's inline
// line, the compose banner. A refused reconnect sends no POST. Focus moves only
// after the POST resolves, so a refused join never foregrounds a phantom
// window (#244). `rawChannels` is a list because `/join #a,#b` is ONE request
// on the wire (#516); focus lands on the first.
export async function joinChannel(
  t: string,
  networkSlug: string,
  rawChannels: readonly string[],
  key: string | null,
): Promise<void> {
  if (hasNoLiveSession(networkBySlug(networkSlug))) {
    await patchNetwork(t, networkSlug, { connection_state: "connected" });
    // identityMoved.ts: a continuation that outlived its identity sends not
    // one request more.
    if (identityMoved(t)) return;
  }
  // RAW on the wire (display spelling); the server casemaps it.
  await postJoin(t, networkSlug, rawChannels.join(","), key);
  if (identityMoved(t)) return;
  const first = rawChannels[0];
  if (first !== undefined) switchToChannelWindow(networkSlug, first);
}

// issue 2719 — the error sink of the doors that have no line of their own to
// print on: the confirm modal is gone by the time the join answers, an
// invite's [Join] button sits on a row the join is about to replace, and a
// featured link on a parked row sits on a row its own reconnect replaces. So
// a failed join is a toast, on the ONE toast surface (Toasts.tsx).
//
// It used to be a `console.warn`, argued in a comment that said this catch saw
// "only the REST-level failure (401 / network down)". It saw every failure the
// POST can answer, and one of them is the commonest of all: a network with no
// session answers 404 `not_found`, and the person who clicked, confirmed and
// waited saw nothing. A join REJECTION (channel modes, +i/+k/+b) is still not
// this path: the POST succeeds and the server reports the refusal as a
// window_state broadcast.
//
// Scoped to the identity, like #247's presence queue: a toast names a channel
// and a network the signed-in account asked for, so an account switch or a
// logout takes the rows on screen with it. `performJoin` covers the other
// half, refusing to raise one once the identity moved during the await.
type JoinToast = { networkSlug: string; rawChannel: string; message: string };

const failures = identityScopedStore((onIdentityChange) => {
  const queue = createToastQueue<JoinToast>();
  onIdentityChange(queue.clear);
  return queue;
});

export const joinToasts = failures.toasts;
export const dismissJoinToast = failures.dismiss;

/**
 * The toast's sentence, beside its producer so the unit tests match the
 * production copy instead of a retyped string. `message` is the server's
 * refusal in its localized copy (`errorMessage`), or a transport failure's own
 * text.
 */
export function joinToastText(toast: JoinToast): string {
  return `Couldn't join ${toast.rawChannel} on ${toast.networkSlug}: ${toast.message}`;
}

/**
 * THE producer of the join toast: `performJoin` below, and a HomePane
 * featured link whose own reconnect replaced the row it would have printed on
 * (review F1 of PR 2747). One producer, so both doors share one queue, one
 * identity check and one copy. `t` is the token the join was sent with.
 */
export function raiseJoinFailure(
  t: string,
  networkSlug: string,
  rawChannel: string,
  err: unknown,
): void {
  // An account that did not click is owed nothing, and must not be told
  // about a channel the previous one asked for.
  if (identityMoved(t)) return;
  failures.queue({ networkSlug, rawChannel, message: errorMessage(err) });
}

async function performJoin(networkSlug: string, rawChannel: string): Promise<void> {
  const t = token();
  if (!t) return; // post-logout race — nothing to join with.
  try {
    await joinChannel(t, networkSlug, [rawChannel], null);
  } catch (err) {
    raiseJoinFailure(t, networkSlug, rawChannel, err);
  }
}

// #902 — THE invite-acceptance verb: join and foreground, no confirm.
//
// The 20% that differs from `confirmJoinChannel` below is intent. A
// `#channel` in prose is ambiguous, so a scrollback click asks first. An
// [Join] button ON an invite is not ambiguous — the operator is answering a
// question that was put to them — so asking again is noise.
//
// Both of its callers used to own a private copy of this body: the invite
// row's CTA (`ScrollbackPane.handleJoinChannel`) and, as of #902, the invite
// BANNER. Two copies of "postJoin then foreground the folded key" is exactly
// the drift CLAUDE.md's one-feature-one-code-path rule exists to stop, and
// the banner made the second copy unavoidable — the scrollback one was
// component-local, closed over `props.networkSlug`.
//
// Casing split as everywhere else (#510/#516/#525): RAW on the wire, FOLDED
// for focus. Focus moves only AFTER the await, so a rejected join (+i/+k/+b)
// never foregrounds a phantom window (#244).
export function acceptInvite(networkSlug: string, rawChannel: string): void {
  void performJoin(networkSlug, rawChannel);
}

// #976 — THE invite-REFUSAL verb, and the other half of the question
// `acceptInvite` answers. It lives here beside its twin rather than in
// windowClose.ts: the two are the two answers to one question, and the
// window-close file owns the PART, which this is emphatically not.
//
// This REVERSES the #902 ruling that the banner's × writes nothing. That
// ruling rested on "an invite is allowed to be lost", which was true in
// principle and false in the code: nothing ever dropped an `:invited` window
// except JOINing it, so the server re-announced the invite on every cold
// subscribe until the operator gave in (#976 — "sennò è cazzo stalking"). The
// × is the decline now; there is no second "hide for now" affordance, because
// one control that means one thing beats two controls the operator has to
// tell apart on a banner.
//
// NOTHING is sent upstream — IRC has no DECLINE — so the peer never learns
// they were refused. The banner copy says so; do not quietly turn this into a
// wire message.
//
// No confirm gate (unlike `confirmLeaveChannel`): a refused invite costs
// nothing to undo, since the peer can simply invite again. No optimistic
// local drop either — the server owns window state, and its
// `window_invite_declined` broadcast is what clears the banner, here and on
// every other device (CLAUDE.md: cic NEVER originates state).
export function declineInvite(networkSlug: string, rawChannel: string): void {
  const t = token();
  if (!t) return; // post-logout race — nothing to decline with.
  // RAW on the wire, as with the JOIN (#510/#516/#525): only the server
  // knows this network's CASEMAPPING, and it folds the window key itself.
  void deleteInvite(t, networkSlug, rawChannel).catch((err: unknown) => {
    // Fire-and-forget, no error surface, and deliberately not performJoin's
    // toast: a `not_invited` here means the window already left `:invited`
    // (joined, or declined on another device) — the banner is about to
    // disappear from that state change anyway.
    console.warn(`[#976 decline] failed to decline ${rawChannel} on ${networkSlug}:`, err);
  });
}

// Already in the channel ⇒ switch, no modal. Otherwise confirm, then join on
// yes. The confirm body names the RAW channel (display casing).
//
// issue 2719 — on a network with no session the question names the reconnect
// too, and comes BEFORE it (the orch's ruling Q1, option A): a park is the
// person's own act, so nothing undoes it without a yes, and one yes covers
// both. Cancel sends nothing. The store is read when the question is ASKED;
// `joinChannel` reads it again when the yes arrives, so a network another
// device reconnected meanwhile gets the POST alone, and one another device
// parked meanwhile is reconnected by a yes that named only the join — the join
// needs the session either way.
export function confirmJoinChannel(networkSlug: string, rawChannel: string): void {
  const joined = windowStateByChannel()[channelKey(networkSlug, rawChannel)] === "joined";
  if (joined) {
    switchToChannelWindow(networkSlug, rawChannel);
    return;
  }
  const reconnect = hasNoLiveSession(networkBySlug(networkSlug));
  requestConfirm({
    title: "Join channel",
    body: reconnect
      ? `${networkSlug} is disconnected. Reconnect it and join ${rawChannel}?`
      : `Join ${rawChannel}?`,
    confirmLabel: reconnect ? "Reconnect and join" : "Join",
    onConfirm: () => void performJoin(networkSlug, rawChannel),
    alternative: null,
    attachments: null,
    choice: null,
    toggle: null,
    defaultButton: "cancel",
  });
}
