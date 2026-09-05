import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Show,
  untrack,
} from "solid-js";
import { isDiagEnabled } from "./DiagFloat";
import { awayByNetwork } from "./lib/awayStatus";
import { channelKey } from "./lib/channelKey";
import {
  draftFramePreview,
  getDraft,
  isDraining,
  isQueueFull,
  isSending,
  recallNext,
  recallPrev,
  setDraft,
  submit,
  tabComplete,
} from "./lib/compose";
import { placeCaretAtEndInView, placeCaretInView } from "./lib/composeCaret";
import { composePlaceholder } from "./lib/composePlaceholder";
import { diagPush } from "./lib/diagLog";
import { frameBudgetForTarget } from "./lib/frameBudget";
import { frameBudgetBaseForNetwork } from "./lib/isupport";
import { createNetworkReconnect } from "./lib/networkReconnect";
import { networkBySlug } from "./lib/networks";
import { routeClipboardPaste, routePastedInput } from "./lib/pasteRoute";
import {
  claimAxis,
  type DragAxis,
  gestureAction,
  type Point,
  type ScrollBoundary,
} from "./lib/swipe";
import { activeHost } from "./lib/uploadHost";
import {
  cancelUpload,
  dismissUpload,
  retryUpload,
  triggerUploads,
  uploadBatch,
  uploadState,
} from "./lib/uploadOrchestrator";
import { windowStateByChannel } from "./lib/windowState";
import { NOT_JOINED_STATES } from "./lib/windowStateSets";

// Sticky-bottom compose surface. Reads + writes compose.ts state;
// dispatches submit on Enter; arrow keys walk per-channel history.
//
// Tab-complete is wired by keybindings.ts (Phase 5) which fires
// cycleNickComplete on Tab in the textarea — keybindings.ts dispatches
// to a handler that Shell.tsx wires to compose.tabComplete. That two-
// hop indirection avoids ComposeBox having to know about the global
// keybinding install; selecting a different focused element won't fire
// the wrong tab handler.
//
// CP15 B5: greyed-state visual when window state is failed/kicked/parked.
// The form root gets `.compose-box-greyed`; an inline "(not joined)"
// label sits beneath the textarea. Compose stays functional — operator
// can still type `/join` / `/part`. Query windows (no state entry) and
// state == "joined" / "pending" render the normal form; pending is the
// post-click optimistic visual feedback while the JOIN echo is in flight.
//
// CP19 T32 parked-window — per-network derivation overlay: when the
// network's credential `connection_state ∈ {parked, failed}` the
// compose box is greyed regardless of the per-window state. Mirrors the
// Sidebar derivation rule so a parked network's selected channel can't
// silently look ready-to-send. Operator can still type `/connect` to
// unpark.
//
// Images cluster I-2 (2026-05-15): three trigger surfaces for upload
// — file picker (paperclip-icon button; iOS Safari's native picker
// still exposes "Take Photo" / "Choose File" so a separate
// camera-capture button would be redundant), drag-drop, clipboard
// paste (textarea). All converge on `triggerUpload()` from
// uploadOrchestrator; the orchestrator handles privacy modal
// gating, MIME pre-check, TTL dropdown wiring, progress state,
// auto-send. ComposeBox is the trigger surface only — no upload
// logic lives here.
//
// #351 — drag-drop is NO LONGER wired on the compose form. The whole
// message pane is the drop target now (`DropUploadZone` in Shell wraps
// ScrollbackPane + ComposeBox), so a nested form-level drop handler would
// double-fire the upload on a compose-area drop AND strand the pane
// overlay (its depth counter never sees the balancing drop). The compose
// area is covered by the pane zone; both go through the SAME shared
// `dropUpload` helper. Clipboard paste stays here (a textarea-scoped
// surface the pane can't observe).
//
// Uploads cluster Task 7 (2026-06-09): the trigger surfaces widened
// from image-only to every categorized MIME — `categoryOf()` is the
// drop/paste filter, the picker's accept attr spans all the active
// host's categories. The host accept-list + per-category cap checks
// stay in the orchestrator (one gate, one error surface); the
// category filter here only stops obviously-uninteresting payloads
// (text selections, random binaries) from opening the upload UI.

export type Props = {
  networkSlug: string;
  channelName: string;
};

// #1108 — how close to the frame's edge the byte countdown appears. Ten
// bytes, per the request: enough warning to finish a word, short enough that
// it is not on screen while composing normally.
const COUNTDOWN_FROM = 10;

// #1675 — `failing` is deliberately NOT in this set. Greyed means "no
// live session; the way back is a reconnect action", and a failing
// network HAS one, retrying on its own — greying it would disable the
// compose box on every network that blinks. The state is still visible:
// HomePane routes anything that is not `connected` to the disconnected
// row, which renders the word AND `connection_state_reason`.
const NETWORK_GREYED_STATES = new Set(["parked", "failed"]);

// #356 — how long a green success/notice stays up before self-clearing.
// The notice is a non-blocking confirmation (e.g. "/notify: watching gigi"),
// so it auto-dismisses; the operator must NOT have to type or send to clear
// it. Errors are a SEPARATE, STICKY severity (role=alert) with no timer —
// you have to read them.
const NOTICE_DISMISS_MS = 3_000;

// #356 — the compose-box feedback line, discriminated by severity:
//   * "error"  → red, role=alert, STICKY (survives until the next submit /
//                input). The failure the operator must read.
//   * "notice" → green, role=status, AUTO-DISMISSES after NOTICE_DISMISS_MS.
//                Success / list output (the /notify + /hilight confirmation
//                strings built in compose.ts, previously computed + discarded).
type Feedback = { text: string; severity: "error" | "notice" };

// #1226 — the away seam copy. State ONLY: no reason echoed back, no tally
// (the #1108 precedent — extra detail in the seam distracts from the one
// thing the line is there to say). Same lowercase-topic register as the
// other notices ("notify: watching gigi").
const AWAY_SET_NOTICE = "away: you are marked as away";
const AWAY_UNSET_NOTICE = "away: you are no longer away";

// #925 — did the pointer come up inside the box it went down on? The one
// piece of geometry in the send button's pointer-driven activation, kept
// pure so the abort-by-sliding-off case is decidable without touch physics.
// Inclusive on all four edges: a release exactly on the boundary is a
// release on the control.
function releasedInside(rect: DOMRect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

// The amber seam line. Its own component only so the feedback `Show`'s
// fallback stays a single expression; the copy and the precedence live at
// the call site.
const SplitWarningLine: Component<{ text: string | null }> = (props) => (
  <Show when={props.text}>
    {(text) => (
      <p class="compose-box-warning" role="status">
        {text()}
      </p>
    )}
  </Show>
);

const ComposeBox: Component<Props> = (props) => {
  const key = () => channelKey(props.networkSlug, props.channelName);

  // #925 — send-button press bookkeeping. Plain `let`s, not signals: nothing
  // renders off them, they only carry state from one event to the next within
  // a single press.
  let pressedPointerId: number | null = null;
  let sentFromPointer = false;
  const [feedback, setFeedback] = createSignal<Feedback | null>(null);
  // Auto-dismiss handle for a shown NOTICE. Held so a new input / new submit /
  // unmount can cancel a pending fire — otherwise a stale timer would clear a
  // freshly-shown notice (or fire after the ComposeBox is gone).
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  const clearNoticeTimer = (): void => {
    if (noticeTimer !== undefined) {
      clearTimeout(noticeTimer);
      noticeTimer = undefined;
    }
  };
  // Clear whatever feedback is up (both severities) + cancel any pending
  // auto-dismiss. The single reset used by new input + submit-start.
  const clearFeedback = (): void => {
    clearNoticeTimer();
    setFeedback(null);
  };
  // Show a green notice that self-clears after the timeout. Any prior timer is
  // cancelled first so back-to-back notices each get a full window.
  const showNotice = (text: string): void => {
    clearNoticeTimer();
    setFeedback({ text, severity: "notice" });
    noticeTimer = setTimeout(() => {
      noticeTimer = undefined;
      // Only clear if it's still the notice we set — a later error must not be
      // wiped by this timer (defensive; the common paths already cancel it).
      setFeedback((f) => (f?.severity === "notice" ? null : f));
    }, NOTICE_DISMISS_MS);
  };
  onCleanup(clearNoticeTimer);

  // #1226 — /away and its un-away twin were silent here: compose.ts's "away"
  // case returns `{ok: true}`, a silent success, so the 💤 sidebar badge was
  // the only cue — and on a phone, sidebar collapsed, there was none at all.
  //
  // The trigger is the SERVER echo, not the local push resolving: the store
  // below is fed by `away_confirmed`, which grappa emits only on the upstream
  // 305 RPL_UNAWAY / 306 RPL_NOWAWAY numerics. That is the ircd's truth rather
  // than our optimism, at the cost of the fake-lag latency (vjt's ruling,
  // 2026-08-11). It also makes this ONE path for every transition — typed
  // /away, auto-away on a WS drop, a toggle from another device — because all
  // three reach the client as the same event. No second branch to tell them
  // apart, which is exactly why the automatic ones are in scope too.
  //
  // Fires on the FLIP only. `prevAway` remembers the slug alongside the value,
  // so mounting into an already-away network and switching the window between
  // an away network and a present one are both silent: the state is not news,
  // only a change to it is.
  let prevAway: { slug: string; away: boolean } | null = null;
  createEffect(() => {
    const slug = props.networkSlug;
    const away = awayByNetwork()[slug] === true;
    const prev = prevAway;
    prevAway = { slug, away };
    if (prev === null || prev.slug !== slug || prev.away === away) return;
    // A sticky red error is NOT displaced. It is up because the operator must
    // read it, and it got there from something THEY did; an away echo can
    // arrive on its own, so overwriting would make a must-read error vanish
    // while the user is doing nothing. Deliberate loss, not an oversight: an
    // away change that lands while an error is showing is seen by nobody here
    // — the 💤 sidebar badge remains the state surface.
    if (untrack(feedback)?.severity === "error") return;
    showNotice(away ? AWAY_SET_NOTICE : AWAY_UNSET_NOTICE);
  });

  let pickerInput: HTMLInputElement | undefined;
  let textareaEl: HTMLTextAreaElement | undefined;
  let swipeStart: Point | null = null;
  // Wall-clock at touchstart (ms). Feeds the touchend velocity gate so a slow
  // release is told apart from a fast flick. Browser time is legitimate here —
  // the Date.now / performance.now ban is a workflow-script rule, not cic
  // runtime. Reset every touchstart; read once, at touchend.
  let swipeStartTime = 0;
  let claimedAxis: DragAxis | null = null;
  // On-device gesture diagnostics (#123): captured once per touch at
  // touchstart so the flag is read a single time, not per move. When on,
  // touchstart / claim / touchend push a line into diagLog for DiagFloat to
  // render — the evidence webkit playwright can't produce.
  let diagOn = false;

  const scrollBoundary = (el: HTMLTextAreaElement): ScrollBoundary => {
    const maxScroll = el.scrollHeight - el.clientHeight;
    return { atTop: el.scrollTop <= 0, atBottom: el.scrollTop >= maxScroll - 1 };
  };

  // #173 — after a history recall the controlled `value` swaps to the recalled
  // line, but the pure compose store (recallPrev/recallNext) only mutates the
  // draft — it never touches the caret or the native scroll. On a recalled line
  // that OVERFLOWS the rows=1 textarea the browser leaves scrollTop at 0 with
  // the end-caret below the fold — you recall a long line and can't see where
  // you're typing (the dogfood symptom; a down-gesture reaches it most reliably
  // because by the #123 mapping it fires only while atTop === scrollTop 0).
  // Place the caret deterministically at the END (irssi recall semantics) and
  // scroll the textarea so that caret is in view. queueMicrotask mirrors the
  // tab-complete precedent: run AFTER the value re-render commits to the DOM.
  // ONE helper, both recall entry points (swipe touchend + keydown ArrowUp/
  // ArrowDown) — the defect and the fix are identical for both, so this is the
  // general "after any recall the caret is visible" rule, not a gesture patch.
  // #1105 moved the body itself out to `lib/composeCaret`: the reply quote hit
  // the same defect because it kept a second, incomplete copy of it.
  const scrollRecallCaretIntoView = (): void => {
    const el = textareaEl;
    if (el === undefined) return;
    placeCaretAtEndInView(el);
  };

  // #178 + #203 — gesture recall gating, split by direction.
  //
  // #178 gated BOTH gesture-recall directions on a non-empty draft: an
  // empty/short (rows=1) draft sits at BOTH scroll edges, so by the #123
  // boundary mapping (`claimAxis`) ANY vertical flick over it claims the
  // gesture, and a fast up-flick then handed off to `recallPrev` —
  // pulling an old sent line into a draft the user never intended to
  // edit.
  //
  // #203 corrected that for swipe-UP: the gate was too broad and broke
  // swipe≡ArrowUp parity. The compose textarea is rows=1 — an EMPTY one
  // has nothing to scroll (the scrollback pane is a SEPARATE touch
  // surface), so the #178 "empty up-flick is a scroll/look gesture"
  // premise doesn't hold there; the only coherent intent of an up-flick
  // over an empty compose is recall — exactly what the physical ArrowUp
  // key does (`onKeyDown`, which #178 always left recalling on empty).
  // So swipe-UP → `recallPrev` now fires UNCONDITIONALLY (see the
  // `case "recall-prev"` below), restoring the stock-mobile-keyboard
  // affordance's parity with the arrow key AND killing the dead-gesture
  // defect where an empty up-flick suppressed native scroll (onTouchMove
  // preventDefault) yet did nothing.
  //
  // `gestureRecallAllowed` is KEPT on swipe-DOWN (`recallNext`): a
  // down-flick's job is "walk back down toward the live draft you
  // stashed on the way up", meaningful only once there IS an in-progress
  // draft — and `recallNext` is a no-op on a null cursor anyway, so
  // gating it costs nothing while preserving #178's scope. `.trim()` so
  // a stray space/newline doesn't count as "content".
  const gestureRecallAllowed = (): boolean => getDraft(key()).trim() !== "";

  // Swipe gestures on the textarea give a stock mobile keyboard (no Tab, no
  // arrows) the same affordances as keys: swipe RIGHT = Tab (nick complete),
  // swipe UP = ArrowUp (older history), swipe DOWN = ArrowDown (newer
  // history). A swipe — not double-tap — because double-tap collides with the
  // OS word-select. TOUCH (not pointer) events: only touchmove.preventDefault
  // reliably suppresses iOS's native scroll + drag-to-select.
  //
  // #123 nested-scroll boundary handoff (2026-07-03) — the textarea is an
  // INNER scroll surface; the swipe is the OUTER gesture. The inner scroll owns
  // the vertical drag WHILE it still has room in that direction; the instant it
  // hits its edge (finger-up → bottom, finger-down → top), it CEDES the rest of
  // this same touch to the gesture. That is why the boundary is read LIVE on
  // every touchmove, not snapshotted at touchstart: a frozen snapshot only ever
  // handed off from an already-at-edge start, so a mid-scrolled draft ate the
  // drag and the gesture only fired on a SECOND touch (the "double-swipe" bug;
  // it appeared to work solely at scrollTop === 0). `claimAxis` owns the
  // direction→edge mapping; the flick test is deferred to touchend over the
  // WHOLE gesture (`gestureAction`), where displacement + elapsed are reliable.
  //
  // These are bound via a ref + addEventListener (see bindSwipe), NOT JSX
  // onTouch* — Solid delegates touch events to a single PASSIVE listener on
  // `document`, where preventDefault silently no-ops. We need an element-level,
  // explicitly non-passive touchmove listener to preventDefault at the handoff.
  const onTouchStart = (e: TouchEvent) => {
    const t = e.touches.length === 1 ? e.touches[0] : undefined;
    swipeStart = t ? { x: t.clientX, y: t.clientY } : null;
    swipeStartTime = performance.now();
    claimedAxis = null;
    diagOn = isDiagEnabled();
    if (diagOn && textareaEl && t) {
      const el = textareaEl;
      diagPush(
        `TS y=${Math.round(t.clientY)} st=${el.scrollTop} sh=${el.scrollHeight} ch=${el.clientHeight}`,
      );
    }
  };

  const onTouchMove = (e: TouchEvent) => {
    if (swipeStart === null || e.touches.length !== 1) return;
    const t = e.touches[0];
    if (t === undefined) return;
    if (claimedAxis === null) {
      // Read the scroll boundary LIVE every move: the textarea may have
      // native-scrolled to its edge DURING this touch, and the gesture must
      // hand off the instant it does. A vertical drag WITH room returns null →
      // we stay hands-off so pan-y scrolls the draft.
      const boundary = textareaEl ? scrollBoundary(textareaEl) : { atTop: true, atBottom: true };
      // #1205 — the DOM half of the selection gate: a non-collapsed selection
      // means this horizontal drag is a handle drag, and claiming it would
      // preventDefault the very thing the user is doing. Live like the
      // boundary, and unreadable counts as collapsed (the pre-#1205 claim).
      const selectionActive =
        textareaEl !== undefined && textareaEl.selectionStart !== textareaEl.selectionEnd;
      claimedAxis = claimAxis(
        swipeStart,
        { x: t.clientX, y: t.clientY },
        boundary,
        selectionActive,
      );
      if (claimedAxis === null) return;
      if (diagOn) {
        const st = textareaEl ? textareaEl.scrollTop : -1;
        diagPush(
          `CLAIM ${claimedAxis} up=${t.clientY - swipeStart.y < 0} atTop=${boundary.atTop} atBot=${boundary.atBottom} st=${st}`,
        );
      }
    }
    // Suppress native scroll + drag-to-select once we own the gesture.
    e.preventDefault();
  };

  const onTouchEnd = (e: TouchEvent) => {
    const start = swipeStart;
    const claimed = claimedAxis;
    swipeStart = null;
    const t = e.changedTouches[0];
    if (start === null || t === undefined) return;
    const end = { x: t.clientX, y: t.clientY };
    // Full-gesture velocity + direction → action (null: never claimed / slow
    // release / no mapped direction). The boundary gate already ran at claim.
    const action =
      claimed === null ? null : gestureAction(start, end, performance.now() - swipeStartTime);
    if (diagOn) {
      const st = textareaEl ? textareaEl.scrollTop : -1;
      diagPush(
        `END claimed=${claimed ?? "no"} act=${action ?? "none"} dy=${Math.round(end.y - start.y)} st=${st}`,
      );
    }
    switch (action) {
      case "recall-prev":
        // #203 — swipe-UP recalls unconditionally (parity with ArrowUp;
        // see gestureRecallAllowed's doc). No empty-draft gate here.
        recallPrev(key());
        scrollRecallCaretIntoView();
        break;
      case "recall-next":
        // #178 — swipe-DOWN recall stays gated on a non-empty draft.
        if (gestureRecallAllowed()) {
          recallNext(key());
          scrollRecallCaretIntoView();
        }
        break;
      case "tab-complete": {
        const ta = e.currentTarget as HTMLTextAreaElement;
        const result = tabComplete(key(), getDraft(key()), ta.selectionEnd, true);
        if (!result) return;
        // #1113 — same reveal as the keybinding door (Shell.cycleNickComplete):
        // one completion engine, one caret placement.
        queueMicrotask(() => {
          placeCaretInView(ta, result.newCursor);
        });
        break;
      }
    }
  };

  // Bind the swipe listeners on the textarea element itself, bypassing
  // Solid's passive document-level event delegation (touchmove MUST be
  // non-passive for preventDefault to take). onCleanup removes them when the
  // ComposeBox is disposed (e.g. channel switch re-creates the textarea).
  const bindSwipe = (el: HTMLTextAreaElement): void => {
    textareaEl = el;
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    onCleanup(() => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      textareaEl = undefined;
    });
  };

  // Bucket F H4: only UserNetwork carries connection_state. Narrow on
  // network.kind before reading the field; visitor networks are
  // never greyed at the network level (visitors have no credential
  // row to park / fail).
  //
  // #1331 — split out of `greyed()` because the two causes are no longer
  // equivalent: a parked/failed NETWORK can be reconnected from here, a
  // failed/kicked WINDOW under a live network cannot (there is nothing to
  // unpark; the way back in is /join). The boolean below still collapses
  // them for the visual, which is unchanged.
  const networkGreyedState = (): string | null => {
    const net = networkBySlug(props.networkSlug);
    if (net?.kind !== "user") return null;
    return NETWORK_GREYED_STATES.has(net.connection_state) ? net.connection_state : null;
  };

  const greyed = (): boolean => {
    if (networkGreyedState() !== null) return true;
    const s = windowStateByChannel()[key()];
    return s !== undefined && NOT_JOINED_STATES.has(s);
  };

  // #1331 — the way OUT, where the operator meets the state. `selection.ts`
  // only redirects to Home on the park TRANSITION, so a cold load or a walk
  // back into the window lands on a greyed compose whose only exit was
  // knowing to go to the home pane. Same PATCH the HomePane chip and the
  // `/connect` slash arm issue — no new verb, no new store: the slug is
  // already a prop and the state already comes from the networks store.
  // The verb + its pending latch + the friendly error mapping come from the
  // shared unit; the SINK is this component's own #356 feedback seam
  // (sticky, role=alert), so the reconnect failure lands on the one error
  // line the compose box already has instead of a second one beside it.
  const reconnector = createNetworkReconnect((message) =>
    setFeedback(message === null ? null : { text: message, severity: "error" }),
  );

  // #1108 — what this draft will do to the wire, from the budget the SERVER
  // published for this network (`frame_budget_base`; cic never computes the
  // #246 relay reserve itself) minus this target's own byte length. `null`
  // all the way through when no budget has arrived: an unseeded network, a
  // parked session, or a server older than the field. Both affordances below
  // then stay dark — a warning computed from an invented budget would be a
  // number the operator cannot act on.
  // A memo, not a plain accessor: both surfaces below read it, and the work
  // behind it is a `parseSlash` plus a full grapheme walk of the draft — per
  // keystroke, twice, if each caller recomputed it.
  const framePreviewNow = createMemo(() => {
    const base = frameBudgetBaseForNetwork(networkBySlug(props.networkSlug)?.id ?? null);
    const budget = frameBudgetForTarget(base, props.channelName);
    return budget === null ? null : draftFramePreview(props.channelName, getDraft(key()), budget);
  });

  // The seam's third state: the draft no longer fits one frame. Copy states
  // the message COUNT and nothing else — a character tally in the seam was
  // ruled out as a distraction (#1108), and the countdown below is where the
  // arithmetic belongs.
  const splitWarning = (): string | null => {
    const preview = framePreviewNow();
    if (preview === null || preview.messages < 2) return null;
    return `your message will send as ${preview.messages} separate messages`;
  };

  // The last ten bytes of the frame, counted down. Hidden until then, and
  // hidden again the moment the draft splits — past the edge the seam line is
  // the honest surface. Zero is shown: at exactly the budget the draft is
  // still ONE message, so leaving it out would blink the counter off for one
  // byte before the warning appears.
  // Formatted here, not in the markup: zero is a legal value and a bare
  // number would be swallowed by the `Show` below as falsy — the one byte of
  // room where the counter must be MOST visible.
  const frameCountdown = (): string | null => {
    const preview = framePreviewNow();
    const remaining = preview?.remainingBytes ?? null;
    if (remaining === null || remaining > COUNTDOWN_FROM) return null;
    return remaining === 0 ? "0" : `-${remaining}`;
  };

  const onInput = (e: Event) => {
    const value = (e.currentTarget as HTMLTextAreaElement).value;
    setDraft(key(), value);
    // #356 — typing dismisses any feedback (notice OR error) + kills a pending
    // auto-dismiss timer, so the seam never lingers over a fresh draft.
    clearFeedback();
  };

  // ---- Upload trigger surfaces (all categories) --------------------

  const onPickerChange = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    // Picker path does NOT pre-filter by category: normalizeUploadFile in
    // the orchestrator relabels iOS .m4r ringtones (octet-stream → audio)
    // that categoryOf would otherwise drop. This is why the picker calls
    // `triggerUploads` and deliberately NOT `dropUpload`, which does filter.
    const files = input.files ? Array.from(input.files) : [];
    // #1883 — the confirm lives in `triggerUploads`, so it is inherited here
    // rather than wired here. #1884's picker-only `pickerUpload` was reversed
    // (vjt's ruling, 2026-08-31) so drop, paste and the OS share-target are
    // guarded by the same door instead of each remembering to ask.
    if (files.length > 0) {
      triggerUploads(key(), props.networkSlug, props.channelName, files);
    }
    // Reset so picking the same file twice still fires `change`.
    input.value = "";
  };

  const onPickerClick = () => {
    pickerInput?.click();
  };

  // Clipboard paste on the textarea → the shared router (lib/pasteRoute):
  // file → upload, big text → flood-confirm, small text → native insert. The
  // SAME router serves the #352 global paste listener, so the two paths can't
  // drift. `textareaEl` (the bound ref) is passed instead of `e.currentTarget`
  // so the router is agnostic to whether the event fired on the textarea or
  // was intercepted at the document.
  const onPaste = (e: ClipboardEvent) => {
    if (textareaEl === undefined) return;
    // nativeInsertAvailable = true: focus is on this textarea, so a
    // below-threshold paste is left to the browser's native insert.
    routeClipboardPaste(e, textareaEl, props.networkSlug, props.channelName, true);
  };

  // #1250 — the same guard for a paste that fires NO `paste` event. GBoard's
  // clipboard chip commits through the input method, which surfaces only as
  // `beforeinput` with an `insertFromPaste` inputType, so the flood cap was
  // bypassable by picking that gesture. The router arbitrates the overlap with
  // `onPaste` above (one gesture, one decision) — see its claim comment.
  const onBeforeInput = (e: InputEvent) => {
    if (textareaEl === undefined) return;
    routePastedInput(e, textareaEl, props.networkSlug, props.channelName);
  };

  // #118 — "(i/N)" counter, shown only while a multi-file batch is in
  // flight. A single upload (total 1) renders no counter.
  const batchLabel = (): string | null => {
    const b = uploadBatch(key());
    return b !== null && b.total > 1 ? `(${b.index}/${b.total})` : null;
  };

  const onCancelUpload = () => {
    cancelUpload(key());
  };

  const onRetryUpload = () => {
    retryUpload(key());
  };

  const onDismissUpload = () => {
    dismissUpload(key());
  };

  // ---- Submit ------------------------------------------------------

  // #1059 — the send button's empty-draft refusal. It is read TWICE, and the
  // pair is the whole fix: once to grey the button (`aria-disabled`) and once
  // to refuse the activation. What it must NEVER drive again is the
  // `disabled` attribute — see the button below for why.
  const nothingToSend = (): boolean => getDraft(key()).trim() === "";

  // #904 — no component-local in-flight gate any more. The store owns the
  // one-deep queue keyed on the WINDOW, and it is the only thing that can
  // tell a second Enter (queue it) from a third (refuse it) — a `sending()`
  // here answered "no" to both after any unmount, and answered "yes" to the
  // second one, which is how the operator's next message got eaten.
  const doSubmit = async (): Promise<void> => {
    clearFeedback();
    const result = await submit(key(), props.networkSlug, props.channelName);
    // #356 — three outcomes:
    //   {error}          → sticky red alert (except the "empty" no-op marker).
    //   {ok: string}     → green auto-dismissing notice (the /notify + /hilight
    //                      confirmation output, previously computed + discarded).
    //   {ok: true}       → silent success (draft cleared upstream, no seam).
    if ("error" in result) {
      if (result.error !== "empty") setFeedback({ text: result.error, severity: "error" });
    } else if (typeof result.ok === "string") {
      showNotice(result.ok);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      // #974 — EVERY Enter sends, modifier or not. vjt's ruling (2026-08-07)
      // reverses his 2026-08-06 one: a Shift+Enter that refuses also EATS the
      // keystroke, and on his device the modifier arms itself on presses he
      // never meant as Shift+Enter, so the message silently does not go. What
      // arms it is still unknown — this closes the whole class without needing
      // to know. Ctrl+Enter and Cmd+Enter already fell through to submit, so
      // uniform handling is one case fewer, not one more.
      //
      // preventDefault STAYS: it is what stops the textarea from inserting its
      // own line break, which would otherwise land in the box AFTER the async
      // doSubmit() has cleared the draft. The composer is still single-line —
      // a newline cannot travel inside a PRIVMSG (CRLF terminates the frame),
      // and paste remains the ONE route a multi-line body takes in, guarded by
      // lib/pasteFlood.
      e.preventDefault();
      void doSubmit();
      return;
    }
    if (e.key === "ArrowUp") {
      const ta = e.currentTarget as HTMLTextAreaElement;
      // Only walk history if cursor is on first line; otherwise let
      // native cursor movement handle it.
      const before = ta.value.slice(0, ta.selectionStart);
      if (!before.includes("\n")) {
        e.preventDefault();
        recallPrev(key());
        scrollRecallCaretIntoView();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      const ta = e.currentTarget as HTMLTextAreaElement;
      const after = ta.value.slice(ta.selectionEnd);
      if (!after.includes("\n")) {
        e.preventDefault();
        recallNext(key());
        scrollRecallCaretIntoView();
      }
      return;
    }
  };

  return (
    <>
      {/* #1108 — bytes left in the frame, for the last ten of them. Purely
          visual: aria-hidden, because a live region that changes on every
          keystroke is noise, and the thing worth ANNOUNCING (the draft will
          split) is the polite seam line below. */}
      {/* #1358 — the slot is ALWAYS mounted; only its content comes and goes.
          The countdown used to be a bare `Show` among the root fragment's
          children, and when it arrived in the same flush the split warning
          left — the draft shrinking back under the frame limit — Solid
          reconciled the fragment by DETACHING the <form> and re-attaching it
          after the new sibling. The focused textarea rode along, and a
          detached element loses the focus with nobody calling blur(): on iOS
          that closes the keyboard mid-edit. A stable parent keeps the
          appear/disappear inside this slot, where the form is not a sibling.
          Measured in ComposeBoxFrameSeam.test.tsx over all eight seam
          transitions; only that one moved the form, and only downward.
          The node identity of the textarea is NOT the oracle — Solid handed
          back the same node object across the move, focus already gone. */}
      <div class="compose-box-frame-countdown-slot">
        <Show when={frameCountdown()} keyed>
          {(label) => (
            <p
              class="compose-box-frame-countdown"
              data-testid="compose-frame-countdown"
              aria-hidden="true"
            >
              {label}
            </p>
          )}
        </Show>
      </div>
      <form
        class={`compose-box${greyed() ? " compose-box-greyed" : ""}`}
        onSubmit={(e) => {
          e.preventDefault();
          void doSubmit();
        }}
      >
        <input
          ref={pickerInput}
          type="file"
          multiple
          accept={Object.values(activeHost().acceptedMimeTypes).flat().join(",")}
          data-file-picker
          hidden
          onChange={onPickerChange}
        />
        <button
          type="button"
          class="compose-box-image-picker"
          aria-label="upload file"
          onClick={onPickerClick}
          title="upload file"
        >
          {/* Paperclip icon (Feather) — inline SVG, theme-agnostic. A
           * generic "attach" affordance: the picker accepts every
           * category (image/video/document/audio), and iOS Safari's
           * native picker still exposes "Take Photo" / "Choose File"
           * on this single button — no separate capture input needed. */}
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </button>
        <textarea
          ref={bindSwipe}
          value={getDraft(key())}
          onInput={onInput}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBeforeInput={onBeforeInput}
          // #974 — NOT the fix for that issue, and explicitly not the
          // mechanism behind it (the iOS auto-capitalisation hypothesis was
          // falsified on a real device). Correct on its own merits: with no
          // attribute WebKit applies `sentences`, and this box eats nicks,
          // channel names and `/commands`.
          //
          // #1008 — and it stops there. `autocorrect="off"` was copied in
          // alongside it from the IDENTIFIER inputs (PerformSettings, Login,
          // AliasSettings) and shipped in v0.13.3; on WebKit that attribute
          // also suppresses the QuickType predictive bar, not merely the
          // silent correction, and a reporter on #sniffo could no longer type
          // on a phone. **This box is prose, and prose keeps its typing
          // aids** — the same line `spellcheck` already sits on, which is why
          // `spellcheck` is likewise left alone. Do not re-add `autocorrect`
          // here by copying the pair from an identifier field: those fields
          // want it, a message body does not.
          //
          // Accepted cost, ruled on knowingly in #1008: autocorrection may
          // occasionally rewrite an unusual word — a bare nick typed without
          // tab-completion among them. Being unable to type at all is worse.
          // Having BOTH needs a contenteditable composer with mention spans
          // marked non-correctable; that is its own issue, not a rider here.
          autocapitalize="none"
          // #737 — a paced drain rewrites this draft every acked line for as
          // long as the pacing lasts. The store refuses operator writes while
          // it does (that is the real guard, and it covers the global paste
          // listener too); readOnly makes the refusal VISIBLE instead of
          // swallowing keystrokes, and the submit button's spinner says why.
          // readOnly, not disabled: disabled blurs the textarea, which
          // collapses the on-screen keyboard — the focus steal #59 exists to
          // prevent. Keyed on the WINDOW, not the component-local sending():
          // that one would follow the operator to whatever window they switch
          // to mid-drain and freeze the wrong composer.
          //
          // #904 — the second refusal, same shape: one send in flight plus one
          // queued behind it is the whole depth, and the third message is
          // refused HERE, visibly, instead of being accepted and then eaten.
          // A single in-flight send does NOT lock the box — composing the next
          // one while this one goes out is the feature.
          readOnly={isDraining(key()) || isQueueFull(key())}
          aria-busy={isDraining(key()) || isQueueFull(key())}
          placeholder={composePlaceholder(props.networkSlug, props.channelName)}
          rows={1}
          aria-label="compose message"
          // #352 — stable hook for the boot-time global paste listener
          // (lib/globalPaste) to find the ONE mounted compose surface without
          // coupling to the a11y label.
          data-compose-input
        />
        {/* UX-6 bucket F (2026-05-21) — arrow glyph + aria-label
            preserve a11y + byRole queries. SVG (not Unicode ➤) so the
            glyph survives Linux/Windows font-stack fallback — `.compose-box
            button` inherits `--font-mono` whose Consolas/Liberation/DejaVu
            members lack Dingbats-block codepoints. Matches the camera-
            icon SVG precedent on the sibling picker button. */}
        <button
          type="submit"
          aria-label="send message"
          // #241 — expose the in-flight state to assistive tech: the spinner
          // itself is decorative (aria-hidden), so aria-busy is the a11y twin
          // of the visual swap. Screen readers announce the busy state instead
          // of only the disabled state.
          aria-busy={isSending(key())}
          // #1059 — `aria-disabled`, NEVER `disabled`. A disabled form control
          // is not a mouse-event target, and #925 moved this button's send
          // from `click` to `pointerup`, which on a real tap runs BEFORE
          // `mousedown`: the send empties the draft, an attribute-driven
          // refusal would flip `disabled` on mid-tap, and the `mousedown`
          // carrying the #59 focus-steal cancel below would never be
          // dispatched. Focus leaves the textarea and iOS collapses the
          // keyboard — tapping Send dismissed it while Enter did not, which is
          // exactly the asymmetry #1059 was reported with.
          //
          // The invariant: THE SEND BUTTON MUST REMAIN A MOUSE-EVENT TARGET
          // ACROSS ITS OWN ACTIVATION, because that is where the
          // keyboard-preserve cancel lives. `:565` already carries this lesson
          // for the textarea (readOnly, not disabled, for the same keyboard).
          // Deferring the flip by a frame would also close the window and is
          // deliberately NOT the fix: it makes the guard timing-dependent,
          // which is the shape of the bug, not of its remedy.
          //
          // The refusal it replaces is not lost — it moved into `onPointerUp`,
          // where an activation is what has to be refused. `.compose-box
          // button[aria-disabled="true"]` carries the greying that
          // `:disabled` used to (default.css).
          aria-disabled={nothingToSend()}
          // #59: keep the textarea focused when sending via the button.
          // Tapping a <button> moves focus off the textarea, which collapses
          // the native on-screen keyboard (Android especially). The cancel
          // lands on `mousedown` — the legacy focus-shift carrier — and NEVER
          // on `pointerdown`, which is also iOS's gesture-start signal
          // (lib/keepKeyboard.ts states the rule and the bug that wrote it).
          // The document-level keepKeyboard listener already does this on
          // iOS; this one is what covers Android, where that listener is
          // isIos()-gated and so does nothing at all.
          onMouseDown={(e) => e.preventDefault()}
          // #925 — activation rides the POINTER, not the click. A `type=
          // "submit"` button sends only when a `click` reaches the form, and
          // on real iOS a press the OS routes into a long-press gesture
          // synthesizes no mouse events at all (vjt measured exactly that for
          // #366, 2026-07-21): `:active` lights up, no click ever arrives, the
          // text stays in the field. `pointerup` fires either way.
          onPointerDown={(e) => {
            pressedPointerId = e.pointerId;
            // Re-arm: the previous press may have sent without ever producing
            // a click to consume the swallow flag.
            sentFromPointer = false;
          }}
          onPointerUp={(e) => {
            if (pressedPointerId !== e.pointerId) return;
            pressedPointerId = null;
            // Touch pointers are implicitly captured by the element the press
            // landed on, so a release anywhere still targets this button.
            // Sliding off to abort is the platform's cancel affordance and it
            // must keep working for an irreversible action — hit-test it.
            if (!releasedInside(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY)) {
              return;
            }
            // #1059 — the empty-draft refusal, now that the button is no
            // longer `disabled` and so genuinely receives this event. The pump
            // would no-op an empty body anyway, but an activation that reaches
            // it has already armed the click swallow, so refuse it here where
            // the control's own affordance says it is refused.
            if (nothingToSend()) return;
            sentFromPointer = true;
            void doSubmit();
          }}
          // The synthetic click that follows a normal tap would submit the
          // form a second time. Swallow it — but only a pointer-generated
          // click (`detail > 0`): a keyboard activation reports detail 0 and
          // must always reach the form, since no pointerup carried its send.
          onClick={(e) => {
            if (sentFromPointer && e.detail > 0) e.preventDefault();
          }}
        >
          {/* #241 — in-flight feedback. While a send is in flight for THIS
              window (#904 moved that truth into the store, where it survives
              the unmount a window switch causes; it clears on the send's 201
              ack, the server persisting+broadcasting atomically) the
              paper-plane arrow is swapped for a CSS spinner; it reverts
              to the arrow on resolution. Non-optimistic: the spinner
              reflects the REAL in-flight window, it does NOT fake a sent
              row (cic never originates state). The spinner is a decorative
              (`aria-hidden`) ring like the arrow it replaces — the
              button's `aria-label` carries the a11y name in both states. */}
          <Show
            when={isSending(key())}
            fallback={
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
                data-testid="compose-send-glyph"
              >
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            }
          >
            <span
              class="compose-send-spinner"
              data-testid="compose-send-spinner"
              aria-hidden="true"
            />
          </Show>
        </button>
      </form>
      <Show when={uploadState(key())}>
        {(st) => (
          <Show
            when={st().error}
            fallback={
              // role="status" (polite live region), NOT role="progressbar":
              // the native <progress> below self-announces, and ARIA
              // progressbar has Children Presentational=true — it would
              // flatten the filename / phase label / cancel button out of
              // the a11y tree. status also announces the "processing
              // video…" phase transition (Task 8 a11y review, 2026-06-09).
              <div class="compose-box-upload-progress" role="status">
                <span class="compose-box-upload-filename">{st().filename}</span>
                <Show when={batchLabel()}>
                  {(label) => <span class="compose-box-upload-batch">{label()}</span>}
                </Show>
                <Show when={st().phase === "transcoding"}>
                  <span class="compose-box-upload-phase">processing video…</span>
                </Show>
                <progress value={st().loaded} max={st().total} />
                <button type="button" onClick={onCancelUpload}>
                  cancel
                </button>
              </div>
            }
          >
            <div class="compose-box-upload-error" role="alert">
              <span class="compose-box-upload-filename">{st().filename}</span>
              <Show when={batchLabel()}>
                {(label) => <span class="compose-box-upload-batch">{label()}</span>}
              </Show>
              <span class="compose-box-upload-error-msg">{st().error}</span>
              <button type="button" onClick={onRetryUpload}>
                retry
              </button>
              <button type="button" onClick={onDismissUpload}>
                dismiss
              </button>
            </div>
          </Show>
        )}
      </Show>
      <Show when={greyed()}>
        <p class="compose-box-not-joined muted">
          (not joined)
          {/* #1331 — the action rides the line that already states the
              state, and only on the NETWORK cause. Same accessible name as
              the HomePane chip (`Reconnect <slug>`): it is the same verb on
              the same subject, and the two never render together (HomePane
              renders no compose box). */}
          <Show when={networkGreyedState()}>
            <button
              type="button"
              class="compose-box-reconnect"
              disabled={reconnector.pending()}
              aria-label={`Reconnect ${props.networkSlug}`}
              onClick={() => void reconnector.reconnect(props.networkSlug)}
            >
              {reconnector.pending() ? "Reconnecting…" : "Reconnect"}
            </button>
          </Show>
        </p>
      </Show>
      {/* #356 — feedback seam. Severity drives BOTH the class (red error vs
          green notice) and the ARIA live role: role=alert (assertive) for
          errors the operator must read, role=status (polite) for the
          auto-dismissing success notice. */}
      {/* #1108 — the seam's THIRD state, amber, and the one that loses the
          line: submit feedback (error OR notice) outranks it. An error is
          the more urgent read and the geometry is shared, so both cannot be
          up at once; the collision is real rather than theoretical, because
          a paced send that fails puts its residue back in the draft (#666)
          while its error is still sticky. A notice cannot collide in
          practice — the submit that produced one just emptied the draft, and
          any keystroke clears feedback. */}
      <Show when={feedback()} fallback={<SplitWarningLine text={splitWarning()} />}>
        {(fb) => (
          <p
            class={fb().severity === "error" ? "compose-box-error" : "compose-box-notice"}
            role={fb().severity === "error" ? "alert" : "status"}
          >
            {fb().text}
          </p>
        )}
      </Show>
    </>
  );
};

export default ComposeBox;
