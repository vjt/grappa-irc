import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js";
import CommandMenu from "./CommandMenu";
import { awayByNetwork } from "./lib/awayStatus";
import { type ChannelKey, channelKey } from "./lib/channelKey";
import {
  commandCycle,
  draftFramePreview,
  getDraft,
  isDraining,
  isQueueFull,
  isSending,
  recallNext,
  recallPrev,
  sendText,
  setDraft,
  submit,
  tabComplete,
} from "./lib/compose";
import { placeCaretAtEndInView, placeCaretInView } from "./lib/composeCaret";
import { composePlaceholder } from "./lib/composePlaceholder";
import { frameBudgetForTarget } from "./lib/frameBudget";
import { isComposingKeystroke } from "./lib/imeComposition";
import { frameBudgetBaseForNetwork } from "./lib/isupport";
import { micLevel, startMicMeter, stopMicMeter } from "./lib/micLevel";
import { createNetworkReconnect } from "./lib/networkReconnect";
import { networkBySlug } from "./lib/networks";
import { routeClipboardPaste, routePastedInput } from "./lib/pasteRoute";
import { createPointerSend } from "./lib/pointerSend";
import { bindSwipeRecall } from "./lib/swipeRecall";
import { activeHost } from "./lib/uploadHost";
import {
  cancelUpload,
  dismissUpload,
  retryUpload,
  triggerUploads,
  uploadBatch,
  uploadState,
} from "./lib/uploadOrchestrator";
import {
  dictationAvailable,
  dictationState,
  probeDictation,
  SESSION_MS,
  startDictation,
  stopDictation,
} from "./lib/voiceDictation";
import { encryptedWindowPeer } from "./lib/windowKinds";
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
  // history). The binding itself lives in `lib/swipeRecall` — issue 2429 gave
  // the services console the same gesture, and the review of it refused the
  // second copy. It binds via addEventListener on the element, NOT JSX
  // onTouch* (Solid's delegated touch listener is passive, where
  // preventDefault no-ops).
  const bindSwipe = (el: HTMLTextAreaElement): void => {
    textareaEl = el;
    const unbind = bindSwipeRecall(el, {
      onPrev: () => {
        recallPrev(key());
        scrollRecallCaretIntoView();
      },
      onNext: () => {
        recallNext(key());
        scrollRecallCaretIntoView();
      },
      canNext: gestureRecallAllowed,
      // #1113 — same reveal as the keybinding door (Shell.cycleNickComplete):
      // one completion engine, one caret placement.
      onTab: (ta) => {
        const result = tabComplete(key(), getDraft(key()), ta.selectionEnd, true);
        if (!result) return;
        queueMicrotask(() => {
          placeCaretInView(ta, result.newCursor);
        });
      },
    });
    onCleanup(() => {
      unbind();
      textareaEl = undefined;
    });
  };

  // issue 2222 — no `kind` narrow. The premise paragraph that stood here is
  // deleted rather than corrected (it is the sentence that would put the
  // narrow back): it claimed only a UserNetwork carries `connection_state`
  // and that a visitor has no credential row to park or fail. #211 phase 6
  // retired both halves on BOTH sides of the wire — the two network shapes
  // are byte-identical modulo `kind`, and the server states it outright:
  // "visitors park/reconnect a network through it — visitors carry a real
  // connection_state now" (`NetworksController` moduledoc), whose PATCH door
  // has no subject branch. cic was the last layer still narrowing.
  //
  // 🔴 `NETWORK_GREYED_STATES` above is UNCHANGED and is deliberately NOT the
  // Sidebar's. Here it is {parked, failed}; there it is {failed}, because a
  // parked network leaves the sidebar and has no header left to grey (issue
  // 1985). Those two differed on the same kind long before this change. The
  // ruling uniforms WHO the rule applies to, not two rules that were distinct
  // for a reason — merging them is a separate question, not this one.
  //
  // #1331 — split out of `greyed()` because the two causes are no longer
  // equivalent: a parked/failed NETWORK can be reconnected from here, a
  // failed/kicked WINDOW under a live network cannot (there is nothing to
  // unpark; the way back in is /join). The boolean below still collapses
  // them for the visual, which is unchanged.
  const networkGreyedState = (): string | null => {
    const net = networkBySlug(props.networkSlug);
    if (net === undefined) return null;
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
    return budget === null
      ? null
      : draftFramePreview(props.networkSlug, props.channelName, getDraft(key()), budget);
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

  // issue 2584 — a tap on a `/` menu entry: the command and its space, caret
  // after it, as if typed. The entry kept the focus here (its mousedown is
  // cancelled), so the keyboard stays up for the arguments.
  const pickCommand = (verb: string): void => {
    setDraft(key(), `/${verb} `);
    clearFeedback();
    if (textareaEl) placeCaretAtEndInView(textareaEl);
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

  // ---- Dictation (issue 2611) --------------------------------------
  //
  // The microphone REPLACES the send button while the box is empty, and only
  // where the engine can recognize ON DEVICE (`voiceDictation.ts` says why
  // there is no fallback, and why the answer is asked before the button is
  // drawn). vjt's ruling on the issue (2026-11-11) rejected the second-button
  // workaround: on an empty box there is nothing to send, so the one control
  // there is the microphone — the send button's name and meaning are not
  // taken away from it, they are simply not the question while the field is
  // empty. With text in the box the send button is back, unchanged.
  const dictating = (): boolean => dictationState().phase === "listening";
  const [dictationNow, setDictationNow] = createSignal(Date.now());
  // Where the current session was started. A dictated segment goes to THAT
  // window and no other: the compose box is ONE component whose props follow
  // the selection, so it is not remounted on a window switch, and words said
  // in a private query must never go out in whatever channel is open next.
  let dictationTarget: { key: ChannelKey; networkSlug: string; channelName: string } | null = null;

  // A dictated segment goes out as a message of its own, through the same
  // dispatch a submitted draft takes — and never through the buffer. The
  // operator's half-typed line stays where it is: appending to it sent an
  // unfinished sentence, and a half-typed COMMAND would have run with the
  // dictated words as its arguments (measured by the review).
  const sendDictated = (text: string): void => {
    const target = dictationTarget;
    if (target === null || target.key !== key()) {
      // The operator switched windows mid-session. The words belong to the
      // window the session started in, and there is no honest way to send
      // them from here: stop, and drop them.
      stopDictation();
      return;
    }
    void sendText(target.key, target.networkSlug, target.channelName, text);
  };

  const startDictationHere = (): void => {
    dictationTarget = {
      key: key(),
      networkSlug: props.networkSlug,
      channelName: props.channelName,
    };
    void startDictation(sendDictated);
  };

  /** What a press on the microphone does: start a session, or end the one running. */
  const toggleDictation = (): void => {
    if (dictating()) stopDictation();
    else startDictationHere();
  };

  // The pointer a press on the microphone belongs to (see its `onPointerUp`).
  let micPointerId: number | null = null;

  // A window switch ends the session rather than letting it keep recording
  // into a box that is no longer the one it was started from.
  createEffect(
    on(
      key,
      () => {
        if (dictating() && dictationTarget?.key !== key()) {
          dictationTarget = null;
          stopDictation();
        }
      },
      { defer: true },
    ),
  );

  // The availability question, asked once per page and never on the mount
  // path (see `probeDictation`): until it answers, the send button is what an
  // empty box shows.
  onMount(() => probeDictation());

  // #2611 — nothing native here, on purpose. `checkDictation()` asks the
  // engine `available()` and may `install()` a model: both are native calls,
  // and doing them when the box merely MOUNTS was measured to crash the
  // renderer (a channel window in CI: "Target crashed", then the shard
  // dies). The question is asked on the mic's press instead, inside the
  // gesture; until then the button exists on the cheap, synchronous
  // `dictationSupported()`, and `dictationAvailable() === false` takes it
  // away when the engine says it cannot recognize locally.

  createEffect(() => {
    if (!dictating()) {
      stopMicMeter();
      return;
    }
    void startMicMeter();
    const tick = setInterval(() => setDictationNow(Date.now()), 500);
    onCleanup(() => {
      clearInterval(tick);
      stopMicMeter();
      stopDictation();
    });
  });

  /** The hint's two clocks, in whole seconds: elapsed, and left before the next send. */
  const dictationClocks = (): { elapsed: number; next: number } | null => {
    const state = dictationState();
    if (state.phase !== "listening") return null;
    const now = dictationNow();
    return {
      elapsed: Math.min(SESSION_MS, Math.floor((now - state.startedAt) / 1000)),
      next: Math.max(0, Math.ceil((state.nextSendAt - now) / 1000)),
    };
  };

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

  // #925 — the send button's activation contract, shared with the services
  // console's button (issue 2429; see `lib/pointerSend`).
  const sendButton = createPointerSend({
    canSend: () => !nothingToSend(),
    send: () => void doSubmit(),
    // `type="submit"` inside a `<form>`: the click's default action sends.
    activateOnBareClick: false,
  });

  const onKeyDown = (e: KeyboardEvent) => {
    // issue 2041 — an IME composition owns the keystroke, not us. The Enter
    // that COMMITS a candidate arrives as a plain `key: "Enter"`, and the
    // arrows walk the candidate list; acting on either sends a half-typed
    // line and — via `preventDefault` below — eats the keystroke the IME was
    // waiting for, so the word never finishes either.
    //
    // Placed above the whole chord table on purpose: every branch here is a
    // verb that competes with the IME for the key, so one guard is the
    // smaller diff AND the wider fix. Same predicate on TopicBar (the sibling
    // commit surface) — see `lib/imeComposition` for why it is a module and
    // what it deliberately does not consult.
    if (isComposingKeystroke(e)) return;
    if (e.key === "Enter") {
      // issue 2589 — the ONE exception to #974 below: in an encrypted query
      // a bare Shift+Enter is a line break, left to the textarea. What the
      // window SAYS (text, `/me`) goes out inside an E2E envelope, not as the
      // PRIVMSG text, so a newline in it is no CRLF on the wire and `submit`
      // sends it as one message; a command typed there still runs in clear,
      // one line per message, as a pasted one always did. vjt asked for it
      // knowing #974: a Shift his device arms on its own now breaks the line
      // there instead of sending. Nothing is lost — the break stays in the box
      // and Enter sends it — but it does not go on that press. Only a BARE
      // Shift: a chord with Ctrl, Cmd or Alt keeps sending as #974 has it,
      // rather than falling to whatever the engine does with it — nothing, it
      // may be, which is the eaten keystroke #974 removed.
      if (
        e.shiftKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        encryptedWindowPeer(props.channelName) !== null
      )
        return;
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
      // doSubmit() has cleared the draft. Outside an encrypted query the
      // composer is still single-line — a newline cannot travel inside a
      // PRIVMSG (CRLF terminates the frame), and paste remains the ONE route a
      // multi-line body takes in, guarded by lib/pasteFlood.
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
      {/* issue 2584 — the `/` menu. Same #1358 rule as the countdown slot
          above: the slot is ALWAYS mounted and only its content comes and
          goes, so the menu appearing never makes Solid move the form (and
          the focused textarea in it) to re-order the fragment. */}
      <div class="command-menu-slot">
        <CommandMenu
          draft={getDraft(key())}
          cycle={commandCycle(key())}
          readOnly={isDraining(key()) || isQueueFull(key())}
          onPick={pickCommand}
        />
      </div>
      {/* issue 2611 — while dictating: the microphone's level, how long the
          session has run, and how long before the words gathered so far go
          out on their own. It sits above the box, where the next message
          would appear. */}
      <Show when={dictationClocks()}>
        {(clocks) => (
          <div class="compose-dictation" data-testid="compose-dictation" role="status">
            <span
              class="compose-dictation-wave"
              aria-hidden="true"
              style={{ "--mic-level": String(micLevel()) }}
            >
              <i />
              <i />
              <i />
              <i />
              <i />
            </span>
            <span class="compose-dictation-time" data-testid="compose-dictation-elapsed">
              {clocks().elapsed}s / {Math.round(SESSION_MS / 1000)}s
            </span>
            <span class="compose-dictation-next" data-testid="compose-dictation-next">
              send in {clocks().next}s
            </span>
          </div>
        )}
      </Show>
      <form
        class={`compose-box${greyed() ? " compose-box-greyed" : ""}`}
        onSubmit={(e) => {
          e.preventDefault();
          void doSubmit();
        }}
      >
        {/* issue 2512 — no picker in an encrypted query: it sends text only,
            and the upload door refuses the window (uploadOrchestrator). */}
        <Show when={encryptedWindowPeer(props.channelName) === null}>
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
        </Show>
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
        {/* issue 2611 — THE MICROPHONE TAKES THE SEND BUTTON'S PLACE while the
            box is empty, and only where on-device recognition is usable
            (`dictationAvailable() === true`, asked off the mount path — see
            `probeDictation`). vjt's ruling on the issue: not a second button,
            and no microphone that appears on the cheap API check and vanishes
            on the first tap. With text in the box this slot is the send
            button, unchanged, name included — and while a session runs the
            slot stays the stop control whatever is typed, or the only way back
            to it would be to send the line or delete it.

            While listening the control is stop-and-send, and it SAYS so with a
            different glyph: the same microphone in red would still read as
            "start", which is the opposite of what a press does. */}
        <Show
          when={dictationAvailable() === true && (dictating() || nothingToSend())}
          fallback={
            /* UX-6 bucket F (2026-05-21) — arrow glyph + aria-label
               preserve a11y + byRole queries. SVG (not Unicode ➤) so the
               glyph survives Linux/Windows font-stack fallback — `.compose-box
               button` inherits `--font-mono` whose Consolas/Liberation/DejaVu
               members lack Dingbats-block codepoints. Matches the camera-
               icon SVG precedent on the sibling picker button. */
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
              //
              // issue 2611 — and the slot does not swap it out mid-activation:
              // when a send empties the box the microphone takes this button's
              // place before the compat `mousedown` arrives, so the cancel it
              // carries moved onto the microphone too (`onMouseDown` there), and
              // that button's click swallow keeps the compat click from
              // starting a dictation nobody asked for.
              aria-disabled={nothingToSend()}
              // #59/#925/#1059 — the activation contract (mousedown cancel, the
              // pointerup send, the click swallow) lives in `lib/pointerSend`, one
              // implementation shared with the services console's send button
              // (issue 2429). `activateOnBareClick` stays off here: this button is
              // `type="submit"` inside a `<form>`, so a keyboard activation's
              // DEFAULT ACTION is the send.
              {...sendButton}
            >
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
                  aria-hidden="true"
                  data-testid="compose-send-spinner"
                />
              </Show>
            </button>
          }
        >
          <button
            type="button"
            class="compose-box-mic"
            classList={{ "compose-box-mic--live": dictating() }}
            aria-label={dictating() ? "stop dictating and send" : "dictate"}
            aria-pressed={dictating()}
            data-testid="compose-mic"
            // #59 — this control is what the finger is on when a send empties
            // the box and the slot swaps under it: the compat `mousedown` that
            // follows the send's `pointerup` lands HERE, and without the cancel
            // it steals focus and collapses the keyboard exactly as #1059 says.
            onMouseDown={(e) => e.preventDefault()}
            // #925, the send button's contract: activation rides the POINTER.
            // The compat click after a tap is swallowed by `detail > 0` —
            // including the one that belongs to the send button's activation
            // and only lands here because the slot swapped under it, which must
            // NOT start a dictation.
            onPointerDown={(e) => {
              micPointerId = e.pointerId;
            }}
            onPointerUp={(e) => {
              if (micPointerId !== e.pointerId) return;
              micPointerId = null;
              if (!releasedInside(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY)) {
                return;
              }
              toggleDictation();
            }}
            onClick={(e) => {
              // A keyboard activation reports `detail === 0` and is the only
              // click that acts here: every pointer click was already answered
              // by its own `pointerup`, and a click with no pointerup of ours
              // behind it is the send button's, not a press on the microphone.
              if (e.detail > 0) {
                e.preventDefault();
                return;
              }
              toggleDictation();
            }}
          >
            <Show
              when={dictating()}
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
                  data-testid="compose-mic-glyph"
                >
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="23" />
                  <line x1="8" y1="23" x2="16" y2="23" />
                </svg>
              }
            >
              {/* Stop-and-send: a filled square, the transport's own "stop". */}
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="currentColor"
                stroke="none"
                aria-hidden="true"
                data-testid="compose-mic-stop-glyph"
              >
                <rect x="6" y="6" width="12" height="12" rx="1.5" />
              </svg>
            </Show>
          </button>
        </Show>
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
