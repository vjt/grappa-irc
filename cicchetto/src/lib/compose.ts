import { createEffect, createSignal, on } from "solid-js";
import { addAlias, aliases, delAlias } from "./aliasList";
import {
  ApiError,
  ownNickForNetwork,
  patchNetwork,
  postJoin,
  postNick,
  postNotifyAdd,
  postPart,
  postTopic,
} from "./api";
import { token } from "./auth";
import { openBanlistModal } from "./banlistModal";
import { buildBanMask } from "./banMask";
import { setQuery } from "./channelDirectory";
import { type ChannelKey, canonicalChannel, channelKey, decodeChannelKey } from "./channelKey";
import { friendlyError } from "./friendlyError";
import { addHighlight, delHighlight } from "./highlightList";
import { identityScopedStore } from "./identityScopedStore";
import { markLusersRequested } from "./lusersBundle";
import { membersByChannel } from "./members";
import { clearMentionsBundle } from "./mentionsWindow";
import { splitMessageLines } from "./messageLines";
import { openModeModal } from "./modeModal";
import { networkBySlug, networkIdBySlug, user } from "./networks";
import { asciiFold, nickEquals } from "./nickEquals";
import { registerPing } from "./pingCorrelation";
import { ensureQueryTopicJoined } from "./queryTopicJoin";
import { canonicalQueryNick, openQueryWindowState } from "./queryWindows";
import { quitAll } from "./quit";
import { sendMessage as sendPrivmsg } from "./scrollback";
import { selectedChannel, setSelectedChannel } from "./selection";
import { openServiceModal } from "./serviceModal";
import { isServicesSender } from "./servicesSender";
import { requestOpenSettings } from "./settingsNav";
import { parseSlash } from "./slashCommands";
import {
  pushAwaySet,
  pushAwayUnset,
  pushChannelBan,
  pushChannelBanlist,
  pushChannelDeop,
  pushChannelDevoice,
  pushChannelInvite,
  pushChannelKick,
  pushChannelMode,
  pushChannelOp,
  pushChannelTopicClear,
  pushChannelUmode,
  pushChannelUnban,
  pushChannelVoice,
  pushInfo,
  pushLinks,
  pushLusers,
  pushMotd,
  pushNames,
  pushOper,
  pushRaw,
  pushRecover,
  pushVersion,
  pushWho,
  pushWhois,
  pushWhowas,
  resolveUserhost,
} from "./socket";
import { openUmodeModal } from "./umodeModal";
import { closeQueryWindow } from "./windowClose";
import { LIST_WINDOW_NAME, SERVER_WINDOW_NAME } from "./windowKinds";
import { windowStateByChannel } from "./windowState";

// RFC 2812 channel sigils. The CORRECT source is the server's ISUPPORT
// `CHANTYPES`, but nothing in this stack parses it: `Grappa.Session.ISupport`
// carries CHANMODES / PREFIX / STATUSMSG / CASEMAPPING only, and cic's
// `isupport.ts` store mirrors just chanmodes + prefix. So this is the same
// literal class already open-coded across cic (slashCommands, linkify,
// pushPayload, ScrollbackPane) — hoisted here so this file has ONE copy.
// TODO(#30): plumb CHANTYPES through `isupport_changed` and read it per
// network instead of assuming the RFC set.
const CHANNEL_SIGIL = /^[#&+!]/;

// #1003 — IRC nicks wear decoration (`_omino_`, `bob^`, `gio-vanni`), so
// Tab must reach `_omino_` from the bare `omi`. Deliberately NOT taught to
// `asciiFold`: that helper is protocol IDENTITY (the cic mirror of
// `Grappa.IRC.Identifier.canonical_nick/1`, shared with nickColor /
// notifyWatch / channelKey / pingCorrelation), and folding `_` there would
// make `foo` and `f_o_o` the SAME person for highlight, colour and
// presence. This one is local to the completion matcher, where a wrong
// guess costs a second Tab, not an identity merge.
const stripNickDecoration = (s: string): string => s.replace(/[[\]\\`_^{|}-]/g, "");

// Per-channel compose state. Owns:
//   * `composeByChannel` — { draft, history, historyCursor } per key.
//     `historyCursor === null` = at-bottom (typing fresh draft);
//     non-null cursor walks the history array.
//   * `getDraft(key)` / `setDraft(key, value)` — read/write current draft.
//   * `recallPrev(key)` / `recallNext(key)` — up/down history walk.
//   * `submit(key, slug, channel)` — parses slash + dispatches; pushes
//     non-empty bodies to history; clears draft on success.
//   * `tabComplete(key, input, cursor, forward)` — pure helper.
//
// Identity-scoped via identityScopedStore — logout flushes ALL drafts
// + histories + the tab-cycle anchor (dup-A3 close).
//
// History semantics: most-recent-last; cursor walks BACKWARDS from the
// tail (recallPrev decrements cursor index). At index 0 (oldest)
// recallPrev clamps; at history.length (one past newest) recallNext
// returns the user to a fresh empty draft.

type ComposeState = {
  draft: string;
  history: string[];
  historyCursor: number | null; // null = bottom (live draft)
  // Live, unsent draft parked when the user walks UP into history; restored
  // verbatim when recallNext returns to the bottom. Without it the first
  // ArrowUp on a half-typed line silently ate the text (history[next]
  // overwrote draft) and recallNext handed back "" instead of the draft.
  stashedDraft: string;
};

// ok: true = silent success (draft cleared, no feedback to user).
// ok: string = success with inline feedback (e.g. watchlist list output).
// error: string = failure, displayed inline; draft preserved.
type SubmitResult = { ok: true | string } | { error: string };

// #904 — `submit` (the pump) OWNS the composer buffer: it takes the text out
// at dispatch and hands it back if the submission fails, so every failure
// path preserves the draft without each of the ~40 arms knowing about it.
// The multi-line #666 drain is the ONE exception — it claims the buffer
// (#737) and mirrors its own, finer-grained residue into it, so it says
// `keptBuffer` and the pump keeps its hands off instead of dropping the whole
// paste back on top of the remainder.
type DispatchOutcome = SubmitResult | { error: string; keptBuffer: true };

// #904 — one window's send queue: an entry exists while a submission from it
// is in flight, and `queued` holds the at-most-one message sent behind it.
type Outbox = { queued: string | null };

const empty = (): ComposeState => ({
  draft: "",
  history: [],
  historyCursor: null,
  stashedDraft: "",
});

// #772 — an unsent draft used to die with the document, so every reload path
// ate it: the #674 refresh banner, a manual reload, the #695 stale resume.
// #674 made that automatic once the operator has been away past a dwell — and
// the draft they walked away from mid-sentence is exactly the one it discards.
//
// sessionStorage, NOT localStorage. The issue left the tier open; the codebase
// had already answered it for this exact question. `staleResume.ts` keeps its
// "when was THIS document last alive" stamp in sessionStorage because that is
// per-window-lifetime: it survives a reload and a suspension, and it does not
// leak between tabs. A half-typed line is the same kind of fact — it belongs
// to the window the operator is typing in. In localStorage two tabs on the
// same channel would overwrite each other's buffer, which is a worse bug than
// the one being fixed, and every reload path #772 names happens in-place
// (`window.location.reload()`), so nothing needs to outlive the tab.
//
// The issue also asked how drafts get evicted. They don't, because this is not
// an archive: it MIRRORS the live store, and the store clears a draft when it
// is sent or erased. What is persisted is "which channels have unsent text
// right now", which a human bounds on their own. Nothing accumulates, so
// nothing needs sweeping — and a logout purges it for free, because the
// identity reset empties the store and the mirror follows it down.
//
// Only `draft` crosses. History, the history cursor and the #666 stashed
// draft are in-session mechanics, not the thing the operator would miss.
const DRAFTS_KEY = "cicchetto.composeDrafts";

// Boundary parse: these bytes can come from a different bundle version or a
// hand-edited devtools session, and a throw here would abort the whole store
// build and leave cic with no composer at all. Shape-check each entry and drop
// what doesn't fit, rather than trusting the cast.
const loadPersistedDrafts = (): Record<ChannelKey, ComposeState> => {
  const raw = sessionStorage.getItem(DRAFTS_KEY);
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out: Record<ChannelKey, ComposeState> = {};
  for (const [key, draft] of Object.entries(parsed)) {
    if (typeof draft !== "string" || draft === "") continue;
    out[key as ChannelKey] = { ...empty(), draft };
  }
  return out;
};

const persistDrafts = (states: Record<ChannelKey, ComposeState>): void => {
  const drafts: Record<string, string> = {};
  for (const [key, state] of Object.entries(states)) {
    if (state.draft !== "") drafts[key] = state.draft;
  }
  const keys = Object.keys(drafts);
  if (keys.length === 0) sessionStorage.removeItem(DRAFTS_KEY);
  else sessionStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
};

// #591 — the single CTCP frame builder: `\x01VERB\x01` (no args) or
// `\x01VERB args\x01`. This is the ONE place that wraps a body in CTCP `\x01`
// framing — shared by /me (verb ACTION, one frame per line) and /ctcp
// (arbitrary verb, single frame). Empty args yield NO trailing space, so a
// bare `/ctcp bob version` frames as `\x01VERSION\x01`, not `\x01VERSION \x01`.
export const ctcpFrame = (verb: string, args: string): string =>
  args === "" ? `\x01${verb}\x01` : `\x01${verb} ${args}\x01`;

// #666 — resumable, self-pacing multiline fan-out.
//
// A paste sends one PRIVMSG per line, but the server's send door (the
// per-(subject, network) token bucket, #340) refuses a burst past its
// capacity with a 429. Pre-#666 the first 429 rejected the for-await loop and
// EVERY remaining line was silently dropped, while the draft (cleared only on
// success) still held the WHOLE body — so resending duplicated the delivered
// lines AND immediately re-tripped the throttle. The fix makes a 429 a pause,
// not a failure: wait the server's retry-after, then retry THIS line (a
// refused line was never delivered, so retrying is neither a drop nor a dup).
// Only a fatal error stops the drain.

// Fallback wait when a 429 arrives with no parseable retry-after (the server
// always sends one now — messages_controller/#666 — but a proxy could strip
// the header). Matches the send throttle's default 0.5/s refill (1 token / 2s).
const DEFAULT_RETRY_AFTER_MS = 2_000;

// Upper clamp on a server-supplied retry-after. grappa emits 2s; the clamp is
// purely defensive so a hostile/misconfigured intermediary can't inject a huge
// `retry-after` and freeze the composer (the retry cap bounds the COUNT of
// waits, this bounds their DURATION).
const MAX_RETRY_AFTER_MS = 60_000;

// Safety valve: how many times ONE line is re-paced against a persistent 429
// before the fan-out gives up and surfaces the throttle. An honest send door
// admits on the FIRST retry once a token has refilled (we waited its own
// retry-after), so the cap is only reached by a door that refuses PAST its own
// hint (a misbehaving/severed server, or a proxy 429) — the guard that keeps
// the composer from hanging on an unbounded retry loop. Generous enough to
// absorb timer jitter around the refill boundary.
const MAX_PACED_RETRIES_PER_LINE = 5;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// A send-door 429 — the ONLY error class the fan-out paces-and-retries rather
// than surfacing. Everything else (WS down, invalid_line, a severed-session
// 401) is fatal and stops the drain.
const isSendThrottled = (e: unknown): e is ApiError => e instanceof ApiError && e.status === 429;

// ms to wait before retrying a throttled line. `api.ts readError` parses the
// server's `retry-after` header (seconds) into `info.retry_after`; convert to
// ms, falling back to the send-throttle default if it's missing/garbage.
const retryAfterMs = (e: ApiError): number => {
  const seconds = e.info.retry_after;
  const ms =
    typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
      ? seconds * 1_000
      : DEFAULT_RETRY_AFTER_MS;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
};

// Split a free-text body into one PRIVMSG per line (see messageLines.ts for
// the wire-framing why) and send each, in order. `action` wraps every line in
// CTCP ACTION framing for /me (via the shared `ctcpFrame` builder). Sequential
// await preserves wire order; a single-line body loops exactly once (the
// common path). Shared by the privmsg, me, and msg send sites — the only
// free-text paths whose body can contain an operator-typed newline.
//
// #666 — a send-door 429 retries the SAME line after the server's retry-after
// (never advancing `sent` past a refusal → never a drop, never a dup); any
// other error stops and propagates. `onProgress` (optional) fires after every
// acked line AND before every pace/stop, with the count sent so far and the
// unsent remainder joined back into a body — compose `submit` mirrors that
// remainder into the draft so it holds ONLY what has not gone out. External
// callers (ServiceModal, RegistrationWizardModal) pass no callback and simply
// inherit the never-drop + pacing behaviour.
export const sendBodyLines = async (
  slug: string,
  target: string,
  body: string,
  action: boolean,
  onProgress?: (sent: number, total: number, residue: string) => void,
): Promise<void> => {
  const lines = splitMessageLines(body);
  const total = lines.length;
  let sent = 0;
  // Consecutive paced retries of the CURRENT line; reset when `sent` advances.
  let retries = 0;
  while (sent < total) {
    // `?? ""` satisfies noUncheckedIndexedAccess; `sent < total` guarantees a value.
    const line = lines[sent] ?? "";
    try {
      await sendPrivmsg(slug, target, action ? ctcpFrame("ACTION", line) : line);
      sent += 1;
      retries = 0;
      onProgress?.(sent, total, lines.slice(sent).join("\n"));
    } catch (e) {
      // The residue always starts at `sent` — the first line NOT yet acked.
      // On a 429 that is the refused line (retry it after pacing); on a fatal
      // error it is the line that failed (kept, not dropped). Either way the
      // caller's draft must hold exactly lines[sent..].
      onProgress?.(sent, total, lines.slice(sent).join("\n"));
      // Auto-pace ONLY a multi-line paste (the #666 domain): a SINGLE throttled
      // send surfaces immediately, preserving #342's throttle-copy affordance.
      // `retries` caps the wait against a door that refuses past its own
      // retry-after (misbehaving/severed server) so the composer never hangs —
      // an honest throttle admits on the first retry once a token has refilled.
      if (isSendThrottled(e) && total > 1 && retries < MAX_PACED_RETRIES_PER_LINE) {
        retries += 1;
        await sleep(retryAfterMs(e));
        // loop retries the same `sent` index — never advanced past a refusal.
      } else {
        throw e;
      }
    }
  }
};

const exports_ = identityScopedStore((onIdentityChange) => {
  // #772 — seeded from the previous document's unsent drafts. The textarea is
  // `value={getDraft(key())}`, so restoring the store IS restoring the UI:
  // nothing in ComposeBox changes, and a restored draft simply looks like the
  // reload never happened (no "restored" badge — a textarea that kept its text
  // is what every other text field on the web already does).
  const [composeByChannel, setComposeByChannel] = createSignal<Record<ChannelKey, ComposeState>>(
    loadPersistedDrafts(),
  );

  // The mirror. `defer` so the boot read is not immediately written back, and
  // `on` so this tracks the store and nothing else. It is write-only toward
  // storage — it never puts anything INTO the composer after boot, which is
  // what keeps #907's guarantee intact: the claim→prepare→first-write window
  // gains no new writer, and no await is introduced anywhere near it.
  createEffect(on(composeByChannel, persistDrafts, { defer: true }));

  // Tab-complete cycle anchor. Continuation is detected by RANGE, not by
  // word equality, so it survives the ": "/" " suffix that sits after the
  // caret and a re-tap that lands the caret anywhere inside the inserted
  // nick. `suffix` is the persistent positional suffix for the whole cycle;
  // `lastInsertion` is the exact text written last (nick+suffix, OR the
  // typed word in the revert slot) — the continuation guard compares the
  // anchored span against it.
  let tabCycle: {
    key: ChannelKey;
    typedWord: string; // original-case word the user typed; restored in revert slot
    prefix: string; // lowercased typedWord; the match filter
    idx: number; // 0..matches.length; === matches.length is the revert slot
    anchorStart: number;
    anchorEnd: number;
    lastInsertion: string;
    suffix: string; // ": " (line start) or " " (mid-sentence)
  } | null = null;

  onIdentityChange(() => setComposeByChannel({}));
  onIdentityChange(() => {
    tabCycle = null;
  });
  // #737 — the drain lock is identity-scoped like the drafts it guards. A
  // send that never settles (a backgrounded tab whose fetch never resolves)
  // never runs its release `finally`, and the lock would otherwise outlive a
  // logout/login and leave the composer dead until reload.
  onIdentityChange(() => setDrainingKeys({}));

  const getState = (key: ChannelKey): ComposeState => composeByChannel()[key] ?? empty();

  const writeState = (key: ChannelKey, fn: (s: ComposeState) => ComposeState): void => {
    setComposeByChannel((prev) => ({
      ...prev,
      [key]: fn(prev[key] ?? empty()),
    }));
  };

  const getDraft = (key: ChannelKey): string => getState(key).draft;

  // #737 — a #666 paced drain OWNS the draft it mirrors the residue into, and
  // it can own it for a minute (per line: a 429, the server's retry-after, up
  // to 5 retries clamped at 60s each). The operator cannot share that buffer:
  // whatever they type is overwritten on the next acked line and then wiped by
  // the end-of-submit clear. Refuse the write instead of losing it.
  //
  // The claim is per WINDOW, not per component: a ComposeBox-local `sending()`
  // would follow the operator to whatever window they switch to, freezing that
  // one while leaving the actually-draining window writable. It is also
  // checked HERE rather than at the doors, because every door lands on this
  // store — typing, both paste routes (`pasteRoute` → setDraft), arrow-key and
  // swipe history recall, and tab-complete. Gating one door means the next
  // door added is a fresh instance of this bug.
  const [drainingKeys, setDrainingKeys] = createSignal<Record<ChannelKey, true>>({});

  const isDraining = (key: ChannelKey): boolean => drainingKeys()[key] === true;

  const claimDrafts = (keys: ChannelKey[]): void => {
    setDrainingKeys((prev) => {
      const next = { ...prev };
      for (const k of keys) next[k] = true;
      return next;
    });
  };

  const releaseDrafts = (keys: ChannelKey[]): void => {
    setDrainingKeys((prev) => {
      const next = { ...prev };
      for (const k of keys) delete next[k];
      return next;
    });
  };

  // #904 — the send queue, exactly ONE message deep, per WINDOW. An entry
  // exists for as long as a submission from that window is in flight; its
  // `queued` slot holds the at-most-one message the operator sent behind it.
  //
  // One deep, not unbounded: a backlog over a dead link fires stale lines into
  // the channel minutes later. One line cannot go that stale, and if the link
  // is down there is exactly one line to hand back. Full → the composer is
  // refused VISIBLY (ComposeBox turns the textarea readOnly), which is the
  // whole point — the defect this replaces ate the third message in silence.
  //
  // Keyed on the window, like the #737 drain lock and for the same reason: a
  // ComposeBox-local `sending()` dies on unmount (home / mentions / $list, the
  // desktop↔mobile swap) and follows the operator to the wrong composer.
  const [outboxByKey, setOutboxByKey] = createSignal<Record<ChannelKey, Outbox>>({});

  // Same lifetime hazard as the drain lock: a send that never settles never
  // runs its release, and a stale entry would leave the composer refusing
  // writes across a logout/login.
  onIdentityChange(() => setOutboxByKey({}));

  const isSending = (key: ChannelKey): boolean => outboxByKey()[key] !== undefined;

  const isQueueFull = (key: ChannelKey): boolean => outboxByKey()[key]?.queued != null;

  const setOutbox = (key: ChannelKey, box: Outbox | null): void => {
    setOutboxByKey((prev) => {
      const next = { ...prev };
      if (box === null) delete next[key];
      else next[key] = box;
      return next;
    });
  };

  // Take the queued message out of the slot, freeing it for the next Enter.
  const takeQueued = (key: ChannelKey): string | null => {
    const queued = outboxByKey()[key]?.queued ?? null;
    if (queued !== null) setOutbox(key, { queued: null });
    return queued;
  };

  // #904 — the submission LEAVES the composer here: history first (so a line
  // that is queued, or dies on a dead link, is recallable the moment it is
  // out of the box — pre-fix an eaten message never reached history at all),
  // then the buffer is emptied for the next message.
  const takeDraft = (key: ChannelKey): string => {
    const text = getState(key).draft;
    if (text.trim() !== "") pushHistory(key, text);
    writeState(key, (s) => ({ ...s, draft: "", historyCursor: null }));
    tabCycle = null;
    return text;
  };

  // …and comes back here when it could not be sent. IN FRONT of whatever the
  // composer holds now: the operator typed that AFTER the failed line, so it
  // belongs after it. Never a clobber — that is the destruction #904 is about.
  const handBack = (key: ChannelKey, owed: string[]): void => {
    const text = owed.filter((t) => t !== "").join("\n");
    if (text === "") return;
    writeState(key, (s) => ({
      ...s,
      draft: s.draft === "" ? text : `${text}\n${s.draft}`,
      historyCursor: null,
    }));
  };

  const setDraft = (key: ChannelKey, value: string): void => {
    if (isDraining(key)) return;
    // Any explicit edit (typing, paste, clear) breaks the tab-cycle
    // and resets the history cursor to null (we're back to live draft).
    tabCycle = null;
    writeState(key, (s) => ({ ...s, draft: value, historyCursor: null }));
  };

  const recallPrev = (key: ChannelKey): void => {
    if (isDraining(key)) return;
    writeState(key, (s) => {
      if (s.history.length === 0) return s;
      // Leaving the bottom: park the live draft so recallNext can restore it.
      // Mid-walk (cursor non-null) the live draft is already stashed — keep it.
      const stashedDraft = s.historyCursor === null ? s.draft : s.stashedDraft;
      const cur = s.historyCursor ?? s.history.length;
      const next = Math.max(0, cur - 1);
      const draft = s.history[next] ?? s.draft;
      return { ...s, draft, historyCursor: next, stashedDraft };
    });
  };

  const recallNext = (key: ChannelKey): void => {
    if (isDraining(key)) return;
    writeState(key, (s) => {
      if (s.historyCursor === null) return s;
      const next = s.historyCursor + 1;
      if (next >= s.history.length) {
        // Back at the bottom — restore the parked live draft, not "".
        return { ...s, draft: s.stashedDraft, historyCursor: null };
      }
      return { ...s, draft: s.history[next] ?? "", historyCursor: next };
    });
  };

  const pushHistory = (key: ChannelKey, body: string): void => {
    writeState(key, (s) => ({
      ...s,
      history: [...s.history, body],
      historyCursor: null,
    }));
  };

  // #666 — send a free-text body as one PRIVMSG per line via the resumable,
  // self-pacing `sendBodyLines`, mirroring the UNSENT remainder into the draft
  // after every line so the composer holds ONLY what has not gone out — never
  // the whole body (the pre-#666 resend-duplicates bug). A send-door 429 auto-
  // paces and drains the rest over time (the composer stays busy while it
  // does); a fatal error stops with the residue in the draft and surfaces how
  // many lines made it out. Used by the privmsg / me / msg arms — the free-text
  // paths whose body can be a multi-line paste. On error returns `{error}` —
  // the caller MUST early-return it so the shared end-of-submit draft-clear +
  // history-push never runs (which would wipe the residue and record a
  // half-sent paste).
  //
  // #723 — the residue has EXACTLY ONE owner, and it lands there in RESENDABLE
  // form. A candidate home is a window plus the text that must precede the
  // remainder for a plain resubmit FROM that window to reproduce the sends
  // still owed. In the window that is itself the target, that prefix is empty
  // and the bare remainder resends correctly — the #666 case. Anywhere else it
  // is the command that re-addresses it (`/me `, `/msg <nick> `), because a
  // bare remainder dropped in a CHANNEL composer resends a private message to
  // the channel.
  type ResidueHome = { key: ChannelKey; resubmitPrefix: string };

  // …with one correction for the empty prefix: a residue whose first line
  // starts with `/` is no longer plain text once it is alone in the box —
  // `parseSlash` would DISPATCH it. A paste of "notes\n/quit" that dies on
  // line 2 leaves `/quit`, and Enter parks every network and logs the operator
  // out; `/msg <someone-else>` re-addresses the remainder to a third party.
  // `//` is the literal-privmsg escape the parser already ships, and it only
  // ever needs to cover the FIRST character: parseSlash reads the whole draft,
  // decides once, and hands the rest back for the per-line fan-out. A non-empty
  // prefix needs no escape — the residue is already an argument by then, so
  // `/me /quit` sends the literal text.
  const residueDraft = (home: ResidueHome, residue: string): string => {
    if (residue === "") return "";
    if (home.resubmitPrefix !== "") return `${home.resubmitPrefix}${residue}`;
    return residue.startsWith("/") ? `/${residue}` : residue;
  };

  // `source` is the window the operator submitted from; `preferred` is where
  // the remainder should surface — the same window for privmsg / me, the
  // freshly focused query window for /msg, which moves the operator's eyes
  // there. Two rules pick between them:
  //
  //   * A busy `preferred` outranks us. Its draft is the operator's own
  //     half-typed text, and the final residue of a SUCCESSFUL send is `""` —
  //     so an unconditional write silently ate it. When it is non-empty the
  //     redirect is refused and `source` keeps the remainder (re-addressed by
  //     its own prefix, so it still resends to the intended peer).
  //   * Whoever does NOT own the residue is emptied — so the remainder never
  //     exists twice and Enter back in the source window cannot re-deliver
  //     every line. #904 moved that emptying UPSTREAM: the pump takes the
  //     source draft out at dispatch, before this runs at all. Re-clearing it
  //     here would be a clobber now, not a tidy-up — `/msg` awaits its query
  //     topic join first, and the operator can type into `source` during it.
  //
  // Resolved ONCE, before the first line: per-tick resolution would flip after
  // the first residue write makes `preferred` non-empty, hopping windows
  // mid-drain. Known hole: text typed into `preferred` AFTER that resolution
  // (possible during a long 429-paced drain) is still overwritten.
  //
  // #907 — `prepare` is whatever the arm must arrange before the first line can
  // go out (`/msg` awaits its #254 query-topic join). It runs INSIDE the claim,
  // and that is the whole reason it is a parameter here rather than a statement
  // in the arm: between the composer emptying at dispatch (#904) and the first
  // residue write there must be no moment the operator can type into, or that
  // keystroke is overwritten by the write. Required, never optional, so the
  // next arm that grows an await has to answer the question instead of silently
  // re-opening the gap.
  const sendPacedBody = async (
    source: ResidueHome,
    preferred: ResidueHome,
    slug: string,
    target: string,
    body: string,
    action: boolean,
    prepare: () => Promise<void>,
  ): Promise<DispatchOutcome> => {
    let sentCount = 0;
    let totalCount = 0;
    // #904 — the two buffer regimes of a free-text send, told apart by the ONE
    // property that decides who needs the composer:
    //
    //   * MULTI-LINE — a #666 paced drain. It owns the buffer for as long as
    //     the pacing lasts (a 429 ladder can hold it a minute), mirroring the
    //     shrinking remainder into it, so it CLAIMS the window (#737) and the
    //     operator is refused rather than overwritten.
    //   * SINGLE LINE — the #904 domain. There is no partial state to mirror:
    //     it either acked (residue "") or none of it went out. So the buffer
    //     goes straight back to the operator, who is typing the next message
    //     into it while this one flies; a residue write here would clobber
    //     exactly the text this issue exists to stop losing.
    const multi = splitMessageLines(body).length > 1;
    // #737 × #723 — lock BOTH ends of the drain: the residue home, whose draft
    // the pacing callback rewrites on every acked line, and the window the
    // operator submitted from, so a second Enter there cannot start a rival
    // drain that fans the same remainder out twice. They collapse to one key
    // whenever the residue stays in the window it was typed in. Released in
    // `finally` so a fatal mid-fan-out unlocks the window too: a lock that
    // outlives its drain leaves the composer dead until reload, which is worse
    // than the overwrite it prevents.
    //
    // #907 — claimed BEFORE `prepare`, which means before the home is known,
    // so BOTH candidates are taken: the choice below reads `preferred`'s draft,
    // and a draft that stayed writable across an await would be stale ground to
    // decide on. The loser is handed back the moment the choice is made.
    const claimed = multi ? [...new Set([source.key, preferred.key])] : [];
    claimDrafts(claimed);
    try {
      await prepare();
      const home =
        preferred.key === source.key || getDraft(preferred.key) === "" ? preferred : source;
      // Holding a composer hostage for a drain that will never write to it is
      // its own defect — and `/msg` has just moved the operator's eyes into
      // exactly that window.
      releaseDrafts(claimed.filter((k) => k !== source.key && k !== home.key));
      try {
        await sendBodyLines(slug, target, body, action, (sent, total, residue) => {
          sentCount = sent;
          totalCount = total;
          if (!multi) return;
          // Residue-only draft, reset to the live bottom (historyCursor null):
          // we're typing the remainder, not walking history. A drained send
          // leaves "" — never a bare prefix the operator would have to erase.
          writeState(home.key, (s) => ({
            ...s,
            draft: residueDraft(home, residue),
            historyCursor: null,
          }));
        });
        return { ok: true };
      } catch (e) {
        // Fatal mid-fan-out (WS down, invalid_line, severed 401). The residue
        // draft is already set to the unsent remainder; surface the reason and,
        // for a genuine multi-line paste, how many lines went out so the
        // operator knows the send partially landed. "In the box" means the
        // composer they are looking at — a lie when a busy `preferred` sent the
        // remainder back to the window they submitted from, so that case says
        // where it went whether or not the body was multi-line.
        const reason = friendlyError(e);
        const sentOf = totalCount > 1 ? ` — sent ${sentCount} of ${totalCount} lines` : "";
        // #904 — a single line has no residue to relocate: the pump hands the
        // ORIGINAL text back to the window it was typed in, which needs no
        // re-addressing because it still carries its own `/me ` / `/msg <peer> `.
        // So the "your eyes are elsewhere" test is the FOCUS switch (`/msg`
        // moved them to the query window), not which window won the residue.
        const relocated = multi ? home.key !== preferred.key : preferred.key !== source.key;
        if (relocated) {
          // "The rest" presumes something went out; on a single-line body
          // nothing did, so name the whole message instead.
          const what = totalCount > 1 ? "the rest are" : "your message is";
          const error = `${reason}${sentOf}; ${what} in the window you sent from`;
          return multi ? { error, keptBuffer: true } : { error };
        }
        if (!multi) return { error: reason };
        return { error: `${reason}${sentOf}; the rest are in the box`, keptBuffer: true };
      }
    } finally {
      // Everything ever claimed, including the case `prepare` itself threw:
      // `releaseDrafts` deletes keys, so releasing the loser twice is a no-op.
      releaseDrafts(claimed);
    }
  };

  // The paced-send arms that address a window which already exists have nothing
  // to arrange before their first line (#907: `prepare` is required precisely
  // so that answer is written down rather than assumed).
  const nothingToPrepare = (): Promise<void> => Promise.resolve();

  // #904 — dispatch ONE submission. It never reads or writes the composer
  // buffer: the pump (`submit`, below) hands it the text and owns the
  // put-back, which is what lets every failure arm here just `return {error}`.
  const dispatchDraft = async (
    key: ChannelKey,
    networkSlug: string,
    channelName: string,
    text: string,
  ): Promise<DispatchOutcome> => {
    // #385 — expand user-defined aliases (from the aliasList store) before
    // dispatch; the parser stays pure and takes the map as an argument.
    const cmd = parseSlash(text, aliases());
    // Empty short-circuits before the token check — an empty submit is
    // a no-op regardless of session state, and the consumer (ComposeBox)
    // wants the same outcome whether or not a token is in play.
    if (cmd.kind === "empty") return { error: "empty" };

    // CP13 S9 — server-window only accepts slash-commands. The window
    // has no IRC target a PRIVMSG could go to. Plain text gets a friendly
    // error instead of silently failing or vanishing.
    if (channelName === SERVER_WINDOW_NAME && cmd.kind === "privmsg") {
      return { error: "Server window accepts only slash-commands. Try /raw <line>" };
    }

    const t = token();
    if (!t) return { error: "no session" };

    // Active-channel context helper. Returns the channel name for the
    // current active window, or null if not in a channel window (which
    // would reject ops verbs that require a channel).
    const getActiveChannel = (): string | null => {
      const sel = selectedChannel();
      if (!sel) return null;
      const name = sel.channelName;
      // Channel windows start with '#', '&', '+', or '!' per IRC spec.
      // Query windows use a nick (no # prefix). Server/list/mentions
      // pseudo-windows use synthetic keys that don't start with '#'.
      if (!CHANNEL_SIGIL.test(name)) return null;
      return name;
    };

    // Require a channel window; emit inline error if not in one.
    const requireChannel = (verb: string): string | { error: string } => {
      const ch = getActiveChannel();
      if (!ch) return { error: `/${verb} requires an active channel window` };
      return ch;
    };

    // #122 + #132 + #137 — bare /whois (and /w alias) context-default
    // resolver, the nick twin of requireChannel. The rule collapses to:
    //   * query window → the query partner's nick (#122).
    //   * every OTHER network-scoped window (channel, server, …) → SELF:
    //     the operator's own current nick on this network, via
    //     ownNickForNetwork(net, me) — the canonical resolver (visitor →
    //     me.nick; user → per-credential net.nick), NOT re-implemented
    //     here. #132 introduced the self path for channels; #137 widened
    //     it to every network-scoped window (a server window has a
    //     perfectly good self target — erroring there was a dead-end).
    // The network-less home/admin windows resolve no network here, so the
    // `!own` guard errors — acceptable: they have no nick to self-whois
    // (and in practice no ComposeBox to reach this path: only channel /
    // query / server windows mount one — `kindHasScrollback`).
    const resolveBareWhoisNick = (verb: string): string | { error: string } => {
      const sel = selectedChannel();
      if (sel?.kind === "query") return sel.channelName;
      const net = networkBySlug(networkSlug);
      const own = net ? ownNickForNetwork(net, user()) : null;
      // `!own` (not `=== null`): an empty string is a server-contract
      // violation we still must not forward as a malformed bare WHOIS.
      if (!own) {
        return { error: `/${verb}: own nick for this network is unknown` };
      }
      return own;
    };

    let result: SubmitResult;
    try {
      switch (cmd.kind) {
        case "privmsg": {
          // One PRIVMSG per line — an embedded newline can't ride a single IRC
          // frame (server rejects as :invalid_line). #666 — resumable + paced:
          // a send-door 429 drains the rest over time; a fatal error leaves ONLY
          // the unsent remainder in the draft (early-return so the end-of-submit
          // clear never wipes it).
          // #723 — the residue stays in THIS window and this window IS the
          // target, so the bare remainder resends correctly: no prefix.
          const home = { key, resubmitPrefix: "" };
          const r = await sendPacedBody(
            home,
            home,
            networkSlug,
            channelName,
            cmd.body,
            false,
            nothingToPrepare,
          );
          if ("error" in r) return r;
          result = r;
          break;
        }
        case "me": {
          // CTCP ACTION framing per line: \x01ACTION <text>\x01. Same #666
          // resumable + paced fan-out as privmsg.
          //
          // #723 — the remainder must resend as an ACTION, not as plain text:
          // the residue carries the `/me ` back with it.
          const home = { key, resubmitPrefix: "/me " };
          const r = await sendPacedBody(
            home,
            home,
            networkSlug,
            channelName,
            cmd.body,
            true,
            nothingToPrepare,
          );
          if ("error" in r) return r;
          result = r;
          break;
        }
        // #591 — /ctcp <target> <VERB> [args]: a single CTCP frame to an
        // EXPLICIT target (not the current window), built via the shared
        // `ctcpFrame` seam. Non-ACTION CTCP is single-line by convention
        // (Grappa.IRC.LineSplit) so there is no multiline fan-out. AWAIT the
        // send: a CTCP verb MUST NOT silently no-op when the WS is down.
        case "ctcp": {
          // #640 — a CTCP QUERY (VERSION/PING/TIME/…) is a control-surface
          // probe, not a conversation: its self-echo renders in the SOURCE
          // window (`channelName`, where the operator typed it), NEVER a query
          // window for the recipient. Send to the source window with the wire
          // recipient in `ctcpTarget`; the server keys the echo to the source,
          // carries the recipient in `meta.ctcp_target`, and never auto-opens a
          // window for it.
          //
          // ACTION is the exception — it IS conversation (`/me` to an explicit
          // target), so it belongs in the TARGET window and rides the normal
          // send path unchanged (the server also rejects an ACTION via the CTCP
          // route — `Session.send_ctcp`'s non-ACTION gate). The parser
          // upper-cases the verb; guard case-insensitively regardless.
          const frame = ctcpFrame(cmd.verb, cmd.args);
          if (cmd.verb.toUpperCase() === "ACTION") {
            await sendPrivmsg(networkSlug, cmd.target, frame);
          } else {
            await sendPrivmsg(networkSlug, channelName, frame, cmd.target);
          }
          result = { ok: true };
          break;
        }
        // #591 — /ping <target>: CTCP PING sugar. The token is a client
        // timestamp; it travels in the frame, comes back verbatim in the
        // reply's server-typed meta.ctcp_args, and the RTT is `now - sentAt`.
        // Keyed on the SOURCE window so the RTT line lands where /ping was typed
        // (irssi behavior; synthesized in subscribe.ts).
        //
        // #600 — register the pending entry BEFORE the send, NOT after. The
        // earlier "register after a successful send — the reply cannot precede
        // the send" ordering held only for the WIRE: `sendPrivmsg` is a REST
        // POST, and on a slow/loaded runner its ack resolves AFTER the peer's
        // CTCP PING reply has already been processed on the (separate,
        // already-open) WS. With registration behind the `await`,
        // `maybeConsumePingReply → resolvePing` found no pending entry and
        // dropped the reply — the RTT line never rendered → the 15s CI timeout
        // (deterministic on the CI runner, invisible on a fast local box).
        // Registering first makes the pending present for any reply; if the send
        // below throws, the orphaned entry is inert (one-shot, identity-scoped
        // clear, never resolves without a matching reply).
        case "ping": {
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/ping: network not found" };
          const sentAtMs = Date.now();
          const token = String(sentAtMs);
          // registerPing keys the RTT correlation on the SOURCE window
          // (`key`/`channelName`) so the reply's RTT line lands where /ping was
          // typed — the SAME window the #640 echo now renders in (the two halves
          // finally converge).
          registerPing(networkId, cmd.target, token, key, channelName, sentAtMs);
          // #640 — echo to the SOURCE window (`channelName`) with the wire
          // recipient in `ctcpTarget`; never opens a query window for the peer.
          await sendPrivmsg(networkSlug, channelName, ctcpFrame("PING", token), cmd.target);
          result = { ok: true };
          break;
        }
        case "join":
          // #516 — the parser now returns `channels: string[]`. Rejoin with
          // `,` to reproduce the RFC1459 comma-list on the wire byte-for-byte
          // (the server splits it and opens a `:pending` window per channel,
          // #382) — behaviour is unchanged from the former single `channel`.
          await postJoin(t, networkSlug, cmd.channels.join(","), cmd.key);
          // CP17: server-driven `:pending` window-state origination.
          // Server's `record_in_flight_join/2` writes
          // `window_states[ch] = :pending` and broadcasts
          // `kind: "window_pending"` on `Topic.user/1` — userTopic.ts
          // dispatches into setPending(...). Pre-CP17 cic mutated
          // setPending here optimistically (the only cic-originated
          // state mutation in the codebase) — closed the CLAUDE.md
          // "cic NEVER originates state" hard-invariant violation.
          //
          // Auto-focus the new channel client-side, mirroring the
          // /msg + /query handlers below. The user just typed /join
          // — focus follows intent. Doing this here (instead of
          // relying on subscribe.ts BUG4 self-JOIN handler) closes
          // a race: the JOIN message is broadcast on the per-channel
          // WS topic IMMEDIATELY after channels_changed fires, but
          // cic's subscribe.ts only joins that topic AFTER the REST
          // refetch from channels_changed completes. Phoenix PubSub
          // doesn't replay to late subscribers, so the BUG4 handler's
          // setSelectedChannel never fired in practice. With user-
          // intent-driven focus here, the autojoin / sajoin / NickServ-
          // driven JOIN paths still go through the subscribe.ts handler
          // (no race for those — channel was already joined when JOIN
          // event arrives via WS).
          // #510/#516 — the parser owns the comma split now (`cmd.channels`
          // is already the per-element list). Focus must land on the FIRST
          // channel, folded the SAME way the server folds window keys
          // (`canonicalChannel` = the `Identifier.canonical_channel/1` twin,
          // CASEMAPPING=ascii — A-Z only, brackets untouched; #525). Passing
          // a mixed-case / bracketed first element targets a key no
          // `window_states` entry matches, opening the empty phantom window
          // #510 reported. Single-channel `/join #foo` is a one-element list,
          // so both paths canonicalise the focus key identically.
          setSelectedChannel({
            networkSlug,
            // `channels` is non-empty (the parser errors on a missing name),
            // so `[0]` is never undefined at runtime; the `?? join(",")`
            // fallback exists only to satisfy TS noUncheckedIndexedAccess.
            channelName: canonicalChannel(cmd.channels[0] ?? cmd.channels.join(",")),
            kind: "channel",
          });
          result = { ok: true };
          break;
        case "part": {
          const target = cmd.channel ?? channelName;
          await postPart(t, networkSlug, target);
          result = { ok: true };
          break;
        }
        case "topic-show": {
          // Bare /topic or /topic #chan — render cached topic inline.
          // The cached topic lives in channelTopic.ts; rendering is pure UI.
          // TODO(C3): wire to TopicBar's cached topic for inline render.
          const ch = cmd.channel ?? getActiveChannel();
          if (!ch)
            return { error: "/topic requires a channel — switch to one or use /topic #chan" };
          return { error: `/topic ${ch} (bare) — inline render wired in C3 (TopicBar)` };
        }
        case "topic-set": {
          // /topic <text> or /topic #chan <text> — set topic via REST.
          // Explicit channel wins; otherwise current channel; otherwise bail.
          const ch = cmd.channel ?? getActiveChannel();
          if (!ch)
            return {
              error: "/topic requires a channel — switch to one or use /topic #chan <text>",
            };
          await postTopic(t, networkSlug, ch, cmd.text);
          result = { ok: true };
          break;
        }
        case "topic-clear": {
          // /topic -delete or /topic #chan -delete — clear topic via channel event.
          const ch = cmd.channel ?? getActiveChannel();
          if (!ch)
            return {
              error:
                "/topic -delete requires a channel — switch to one or use /topic #chan -delete",
            };
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/topic -delete: network not found" };
          // S21: AWAIT the verb ack (#154 no-silent-drops). A WS-down / server
          // {:error,_} now rejects into the shared catch → friendlyChannelError
          // inline alert, instead of painting a green ✓ on a dropped frame.
          await pushChannelTopicClear(networkId, ch);
          result = { ok: true };
          break;
        }
        case "nick":
          await postNick(t, networkSlug, cmd.nick);
          result = { ok: true };
          break;
        case "msg": {
          // /msg <target> <text> — open query window, switch focus (user
          // action per spec #1), then send the PRIVMSG immediately.
          //
          // canonicalQueryNick: resolve user-input casing to the existing
          // window's stored casing (RFC 2812 §2.2 — IRC nicks are case-
          // insensitive). `/msg GRAPPA hi` when a `grappa` window already
          // exists MUST focus the existing row and route the send through
          // its ChannelKey — using cmd.target as-is would create a dead
          // "slug GRAPPA" key that no sidebar / scrollback store knows.
          //
          // UX-4 bucket G: *serv targets (NickServ IDENTIFY etc.) skip
          // the open-query + focus-switch — services responses route to
          // the `$server` window server-side (Identifier.services_sender?
          // closed allowlist + EventRouter persist-to-$server), so a
          // services query window would just sit empty. The wire frame
          // still ships (operator's IDENTIFY reaches NickServ); only
          // the optimistic UI-state mutations are skipped.
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/msg: network not found" };
          if (isServicesSender(cmd.target)) {
            // #666 — resumable + paced; residue keyed on the source window
            // `key`, because a services target opens no query window to move
            // it to.
            //
            // #723 — that window is NOT the target, so the remainder must keep
            // its `/msg <service> `. A bare residue here is how a partially
            // sent `/msg nickserv IDENTIFY <pass>` ends up resent to the
            // channel the operator typed it in.
            const home = { key, resubmitPrefix: `/msg ${cmd.target} ` };
            const svc = await sendPacedBody(
              home,
              home,
              networkSlug,
              cmd.target,
              cmd.body,
              false,
              nothingToPrepare,
            );
            if ("error" in svc) return svc;
            result = svc;
            break;
          }
          const canonical = canonicalQueryNick(networkId, cmd.target);
          openQueryWindowState(networkId, canonical, new Date().toISOString());
          setSelectedChannel({ networkSlug, channelName: canonical, kind: "query" });
          // #666 — resumable + paced. The residue PREFERS the QUERY window we
          // just focused (`canonical`) over the source window: /msg already
          // switched focus here, so a partial-send remainder + its error banner
          // must co-locate in the window the operator is now looking at — and a
          // resend of that plain-text residue from the query window goes to
          // `canonical` (the intended peer), not back to the source channel.
          // #723 — a preference, not a seizure: a half-typed draft already in
          // that window belongs to the operator, so sendPacedBody refuses the
          // redirect and keeps the remainder in `key`. Either way exactly one
          // window ends up holding it — and in the source window it keeps its
          // `/msg <peer> `, so resending from a channel cannot spill a private
          // message into that channel.
          //
          // #254 — subscribe-before-send: make the (slug,target) query topic's
          // WS subscription READY (await the join ACK) BEFORE the first PRIVMSG
          // POST, so the server's own-echo broadcast has a live listener and
          // renders live. Pre-fix the join raced the POST (it's gated on the
          // open_query_window → query_windows_list round-trip) and the echo
          // fastlaned to nobody — the row then only reappeared on reload. The
          // echo stays the sole render path (no optimistic local render — cf.
          // the #251 source_address abolition).
          //
          // #907 — it is handed over as the `prepare` step rather than awaited
          // here, so the composer is already claimed while it runs: awaited in
          // the arm, it was a gap between the #904 take-at-dispatch and the
          // first residue write, and a keystroke landing in it was destroyed.
          const r = await sendPacedBody(
            { key, resubmitPrefix: `/msg ${canonical} ` },
            { key: channelKey(networkSlug, canonical), resubmitPrefix: "" },
            networkSlug,
            canonical,
            cmd.body,
            false,
            () => ensureQueryTopicJoined(networkSlug, canonical),
          );
          if ("error" in r) return r;
          result = r;
          break;
        }
        case "service-modal": {
          // #290 — a BARE services command (`/ns`, `/cs`, `/ms`, …) opens
          // the dedicated services console modal and fires `help`, so the
          // service's multi-NOTICE help wall lands confined in the modal
          // (ServiceModal mirrors the $server service notices) instead of
          // flooding the server window. `openServiceModal` FIRST captures the
          // $server high-water mark, THEN `help` is sent, so the reply
          // notices count as while-open arrivals (spec: capture only while
          // open). A full command WITH args stays the `msg` arm above (inline
          // execute, reply inline) — no unsolicited popup for power users.
          openServiceModal(networkSlug, cmd.service);
          await sendBodyLines(networkSlug, cmd.service, "help", false);
          result = { ok: true };
          break;
        }
        case "query": {
          // /query <nick> / /q <nick> — open query window and switch focus.
          // No message sent (spec #1: /query opens window without sending).
          // /query (bare) / /q (bare) on a query-kind window → CLOSES it
          // (irssi convention; this bundle, issue follow-up to #12). Bare
          // /query on any other window kind → error (parser still emits
          // {target: null} for both — semantics resolved here).
          //
          // canonicalQueryNick: see /msg case above.
          //
          // UX-4 bucket G: *serv targets reject — opening a query window
          // for NickServ would be a dead window (services route to $server
          // server-side). Surface as a user-facing error so the operator
          // can re-issue `/msg <Xserv> ...` if they wanted to send.
          //
          // Cross-network safety (bare-close path): resolve the network
          // ID from the SELECTED window's own networkSlug, not from
          // compose's `networkSlug` arg — the two can diverge if the
          // submit was queued before a window switch. Using compose's
          // networkSlug with sel.channelName would no-op or close a
          // wrong-network row when they disagree.
          if (cmd.target === null) {
            const sel = selectedChannel();
            if (sel?.kind === "query") {
              const selNetId = networkIdBySlug(sel.networkSlug);
              if (selNetId === undefined)
                return { error: "/query: selected window's network not found" };
              closeQueryWindow(selNetId, sel.channelName);
              result = { ok: true };
              break;
            }
            return {
              error: "/query <nick> required (bare /query closes the current query window only)",
            };
          }
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/query: network not found" };
          if (isServicesSender(cmd.target)) {
            return {
              error: `/query: ${cmd.target} is a services nick; responses land in the server window — use /msg ${cmd.target} <command>`,
            };
          }
          const canonical = canonicalQueryNick(networkId, cmd.target);
          openQueryWindowState(networkId, canonical, new Date().toISOString());
          setSelectedChannel({ networkSlug, channelName: canonical, kind: "query" });
          result = { ok: true };
          break;
        }
        case "quit": {
          // Nuclear: park ALL bound networks, then logout. The
          // implementation lives in `lib/quit.ts` so the sidebar
          // server-window × (UX-4 bucket D) can call the same path for
          // visitors without re-parsing through here.
          await quitAll(cmd.reason);
          // After logout the component tree will unmount — no further
          // result processing needed. Return early to skip history push.
          return { ok: true };
        }
        case "disconnect": {
          // Surgical: park one network. `network` from parser is null
          // (bare /disconnect) or a named slug. Null → use active-window's
          // networkSlug (already in scope from submit's args).
          const targetSlug = cmd.network ?? networkSlug;
          const disconnBody: { connection_state: "parked"; reason?: string } = {
            connection_state: "parked",
          };
          if (cmd.reason !== null) disconnBody.reason = cmd.reason;
          await patchNetwork(t, targetSlug, disconnBody);
          result = { ok: true };
          break;
        }
        case "connect": {
          // Unpark + respawn. Network slug guaranteed by parser
          // (bare /connect surfaces as kind: "error" instead).
          await patchNetwork(t, cmd.network, { connection_state: "connected" });
          result = { ok: true };
          break;
        }
        case "away": {
          // S3.4 — explicit away set/unset via the user-level Phoenix Channel.
          // The channel push reaches GrappaChannel.handle_in("away", ...) which
          // routes to Session.set_explicit_away / Session.unset_explicit_away.
          // networkSlug from submit args is the active window's network.
          if (cmd.action === "set") {
            // #268 — clear this network's stale mentions bundle HERE, on the
            // user's own GOING-away action, NOT on the `away_confirmed:"away"`
            // echo. The clear MUST be causally ordered with the away lifecycle:
            // the return-from-away `mentions_bundle` is broadcast SYNCHRONOUSLY
            // by grappa on the un-away command, but `away_confirmed` is emitted
            // only on the upstream 305/306 numeric echo (event_router.ex) — a
            // different-latency channel. Under bahamut fake-lag a going-away's
            // delayed 306 could arrive AFTER a subsequent return's bundle and
            // clobber it (the "0 messages in 0 channels" bug). Triggering the
            // clear on the compose action makes it ordered with the user's own
            // commands, so a fresh bundle set on RETURN can never be wiped by a
            // stale echo. The mentions bundle is a client-ephemeral render store
            // (not server-mirrored window/away state), so clearing it on a user
            // action does not violate the "cic never originates state" invariant.
            // Tradeoff: auto-away / cross-device going-away (no compose) no
            // longer clear, so a stale bundle can linger IF the next return
            // carries zero new mentions (the server suppresses the empty
            // broadcast) — a timestamped, secondary-button digest, strictly
            // less harmful than the fresh-bundle-wipe it replaces. A robust
            // auto-away clear would need a server sync-broadcast (out of the
            // "lato client" scope). See docs/DESIGN_NOTES.md 2026-07-16.
            clearMentionsBundle(networkSlug);
            await pushAwaySet(networkSlug, cmd.reason);
          } else {
            await pushAwayUnset(networkSlug);
          }
          result = { ok: true };
          break;
        }
        // ---------------------------------------------------------------
        // Channel ops verbs — push on user-level channel to GrappaChannel.
        // All require a channel window context (except umode and mode which
        // accept their target explicitly).
        // ---------------------------------------------------------------
        // #154(1) — state-changing ops verbs (op/deop/voice/devoice/kick/
        // ban/unban/mode/umode) now `await` their push. Pre-fix these were
        // fire-and-forget: a server `{:error,_}` (invalid_*, no_session,
        // upstream_unavailable, body_too_large) or a WS-down was swallowed
        // and the arm painted a synchronous green ✓ on a dropped frame.
        // AWAIT propagates a rejection to the shared catch below, which maps
        // the `ChannelPushError` to friendly copy via `friendlyChannelError`
        // and surfaces it inline in the compose box — the same contract as
        // `case "oper"` / `case "quote"`.
        case "op": {
          const chanOrErr = requireChannel("op");
          if (typeof chanOrErr !== "string") return chanOrErr;
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/op: network not found" };
          await pushChannelOp(networkId, chanOrErr, cmd.nicks);
          result = { ok: true };
          break;
        }
        case "deop": {
          const chanOrErr = requireChannel("deop");
          if (typeof chanOrErr !== "string") return chanOrErr;
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/deop: network not found" };
          await pushChannelDeop(networkId, chanOrErr, cmd.nicks);
          result = { ok: true };
          break;
        }
        case "voice": {
          const chanOrErr = requireChannel("voice");
          if (typeof chanOrErr !== "string") return chanOrErr;
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/voice: network not found" };
          await pushChannelVoice(networkId, chanOrErr, cmd.nicks);
          result = { ok: true };
          break;
        }
        case "devoice": {
          const chanOrErr = requireChannel("devoice");
          if (typeof chanOrErr !== "string") return chanOrErr;
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/devoice: network not found" };
          await pushChannelDevoice(networkId, chanOrErr, cmd.nicks);
          result = { ok: true };
          break;
        }
        case "kick": {
          const chanOrErr = requireChannel("kick");
          if (typeof chanOrErr !== "string") return chanOrErr;
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/kick: network not found" };
          await pushChannelKick(networkId, chanOrErr, cmd.nick, cmd.reason);
          result = { ok: true };
          break;
        }
        case "ban": {
          const chanOrErr = requireChannel("ban");
          if (typeof chanOrErr !== "string") return chanOrErr;
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/ban: network not found" };
          await pushChannelBan(networkId, chanOrErr, cmd.mask);
          result = { ok: true };
          break;
        }
        case "kb": {
          // #386 — kickban. Ban FIRST (`*!*@host`, no rejoin window), THEN
          // kick — two frames, attempt BOTH regardless (vjt decision #4).
          // The host comes from the on-demand `resolveUserhost` lookup (cic
          // has none client-side); a cache MISS → null → fail-closed (vjt
          // decision #1: never guess a wider mask), so the ban is NOT sent —
          // but the kick still fires (immediate intent) and the ban error is
          // surfaced.
          const chanOrErr = requireChannel("kb");
          if (typeof chanOrErr !== "string") return chanOrErr;
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/kb: network not found" };

          let banError: string | null = null;
          try {
            const uh = await resolveUserhost(networkId, cmd.nick);
            const mask = uh
              ? buildBanMask("host", { nick: cmd.nick, user: uh.user, host: uh.host })
              : null;
            if (mask === null) {
              banError = `/kb: host unknown for ${cmd.nick} — ban not set (run /whois ${cmd.nick} first); kicking anyway`;
            } else {
              await pushChannelBan(networkId, chanOrErr, mask);
            }
          } catch (e) {
            banError = `/kb: ban failed — ${friendlyError(e)}`;
          }

          // Always attempt the kick (getting the person out is the intent).
          try {
            await pushChannelKick(networkId, chanOrErr, cmd.nick, cmd.reason);
          } catch (kickErr) {
            // Both failed → surface the ban error (primary) if present, else the kick's.
            return { error: banError ?? `/kb: kick failed — ${friendlyError(kickErr)}` };
          }

          if (banError !== null) return { error: banError };
          result = { ok: true };
          break;
        }
        // #557 — /kill <nick> [reason]: first-class operator KILL. Unlike
        // /kick/kb this targets a NICK (no channel, no requireChannel) and
        // ships a RAW frame via pushRaw, mirroring /quote — the server already
        // accepts KILL through the raw passthrough (that is what operators do
        // today with `/quote KILL ...`). The whole win is the trailing colon
        // being composed HERE, downstream: `KILL <nick> :<reason>` keeps a
        // multi-word reason intact instead of the /quote foot-gun where a
        // forgotten `:` truncates the reason at its first space. A bare /kill
        // (empty reason) sends `KILL <nick>` and lets the server answer (481
        // for a non-oper, or the ircd's own missing-comment error). AWAIT the
        // push so a WS-down / server {:error,_} surfaces as an inline compose
        // alert, never a silent green ✓ (the #154 no-silent-drop lesson).
        case "kill": {
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/kill: network not found" };
          const line = cmd.reason === "" ? `KILL ${cmd.nick}` : `KILL ${cmd.nick} :${cmd.reason}`;
          await pushRaw(networkId, line);
          result = { ok: true };
          break;
        }
        case "unban": {
          const chanOrErr = requireChannel("unban");
          if (typeof chanOrErr !== "string") return chanOrErr;
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/unban: network not found" };
          await pushChannelUnban(networkId, chanOrErr, cmd.mask);
          result = { ok: true };
          break;
        }
        case "banlist": {
          // #386 — /banlist is now the ban-management MODAL surface (it
          // supersedes the #376 inline BanlistCard, mirroring how the #169
          // /who modal replaced the inline WHO dump). Open the modal AND fire
          // a fresh re-query so the 367/368 list is live on open (pre-#386 it
          // was fire-and-forget only).
          // #536 — the list-mode query form of /mode (`/mode #chan +b`)
          // resolves an explicit channel in the parser; bare /banlist and
          // `/mode +b` carry null → the current channel (same resolver
          // every channel-scoped verb uses).
          const chanOrErr = cmd.channel ?? requireChannel("banlist");
          if (typeof chanOrErr !== "string") return chanOrErr;
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/banlist: network not found" };
          openBanlistModal(networkSlug, chanOrErr);
          pushChannelBanlist(networkId, chanOrErr);
          result = { ok: true };
          break;
        }
        case "invite": {
          // /invite <nick> [#chan] — channel defaults to active window.
          // P-0f follow-up (no-silent-drops bucket 0): when the channel
          // arg is supplied explicitly, SKIP requireChannel — typing
          // `/invite foo #it-opers` from $server (or any non-channel
          // window) was the common workflow that pre-fix silently
          // errored ("requires an active channel window") because
          // requireChannel was unconditionally evaluated.
          let chan: string;
          if (cmd.channel !== null) {
            chan = cmd.channel;
          } else {
            const chanOrErr = requireChannel("invite");
            if (typeof chanOrErr !== "string") return chanOrErr;
            chan = chanOrErr;
          }
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/invite: network not found" };
          // S6 (#364): await the verb-ack so a server {:error,_} / WS-down
          // surfaces inline (shared catch → friendlyChannelError), not a
          // false green ✓. Mirror of kick/ban.
          await pushChannelInvite(networkId, chan, cmd.nick);
          result = { ok: true };
          break;
        }
        case "umode": {
          // /umode — user-mode on own nick, no channel context required.
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/umode: network not found" };
          await pushChannelUmode(networkId, cmd.modes);
          result = { ok: true };
          break;
        }
        case "umode-view": {
          // #229 — bare /umode: open the umode viewer/editor modal for the
          // active window's network. Umodes are per-session (no channel
          // context needed), so any window kind can open it.
          openUmodeModal(networkSlug);
          result = { ok: true };
          break;
        }
        case "umode-target-view": {
          // #229 — /mode <nick> with no mode args. Open the umode modal
          // ONLY when the target resolves to the operator's OWN nick (the
          // modal edits your own umodes; there's no viewer for another
          // user's). Resolve via ownNickForNetwork (visitor → me.nick;
          // user → per-credential net.nick) — the same canonical resolver
          // /whois self-default uses; nickEquals for case-insensitive
          // compare (ASCII, #121/#525). A non-self target is a friendly error rather
          // than a phantom modal.
          const net = networkBySlug(networkSlug);
          const own = net ? ownNickForNetwork(net, user()) : null;
          if (own && nickEquals(cmd.target, own)) {
            openUmodeModal(networkSlug);
            result = { ok: true };
            break;
          }
          return {
            error: `/mode ${cmd.target}: viewing another user's modes isn't supported — use /mode <#channel> for a channel, or /mode ${own ?? "<yournick>"} for your own user modes`,
          };
        }
        case "mode": {
          // /mode <#chan> <modes> [params] — execute directly, raw
          // verbatim, target explicit in args. No modal, no channel-window
          // requirement (#216: mode-args present → apply).
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/mode: network not found" };
          await pushChannelMode(networkId, cmd.target, cmd.modes, cmd.params);
          result = { ok: true };
          break;
        }
        case "mode-view": {
          // #216 — no mode-args: open the viewer/editor modal. Explicit
          // `/mode #chan` targets that channel; bare `/mode` targets the
          // current channel window (error if not in one — the same
          // resolver every channel-scoped verb uses).
          const ch = cmd.channel ?? getActiveChannel();
          if (!ch) return { error: "/mode requires a channel — switch to one or use /mode #chan" };
          openModeModal(networkSlug, ch);
          result = { ok: true };
          break;
        }
        case "mode-apply-current": {
          // #216 — `/mode +s` (mode string, no channel token) applies to
          // the current channel. Mode-args present → execute directly, no
          // modal; requires a channel window.
          const chanOrErr = requireChannel("mode");
          if (typeof chanOrErr !== "string") return chanOrErr;
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/mode: network not found" };
          await pushChannelMode(networkId, chanOrErr, cmd.modes, cmd.params);
          result = { ok: true };
          break;
        }
        // ---------------------------------------------------------------
        // Info verbs — server-side handlers not yet implemented.
        // Emit inline errors as TODO stubs (future bucket wiring).
        // ---------------------------------------------------------------
        // ---------------------------------------------------------------
        // #169 — /who <#chan|nick>. Push on the user-level channel; the
        // server primes who_pending and emits WHO upstream. The 352 burst
        // folds server-side (each also upserting userhost_cache) and 315
        // RPL_ENDOFWHO drains into ONE ephemeral `who_reply` event on the
        // user topic; WhoModal renders the parsed per-user table. NOTHING
        // lands in scrollback (mirrors /names).
        //
        // /who without target → default to the current channel (#122);
        // reject inline only when the active window is not a channel
        // (server requires a channel target — RFC 2812 §3.6.1 allows mask
        // form, out of MVP scope).
        // ---------------------------------------------------------------
        case "who": {
          // #122 — bare /who defaults to the current channel (shares the
          // requireChannel resolver with /names); errors only outside one.
          const target = cmd.target ?? requireChannel("who");
          if (typeof target !== "string") return target;
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/who: network not found" };
          await pushWho(networkId, target); // S6 (#364): await verb-ack
          result = { ok: true };
          break;
        }
        case "names": {
          // #140 — /names [#channel]. Server buffers the 353/366 burst and
          // emits ONE ephemeral `names_reply` on the user topic; NamesModal
          // renders the grouped, scrollable, dismissable roster. The modal
          // is network-scoped (last-write-wins), so the originating window
          // is irrelevant — no origin passed.
          // #122 — bare /names (and /n alias) defaults to the current
          // channel (shares the requireChannel resolver with /who).
          const target = cmd.target ?? requireChannel("names");
          if (typeof target !== "string") return target;
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/names: network not found" };
          await pushNames(networkId, target); // S6 (#364): await verb-ack
          result = { ok: true };
          break;
        }
        case "list": {
          // Channel directory browser (#84). Open the per-network $list
          // pseudo-window (DirectoryPane); the pane loads the snapshot on
          // mount (server auto-refreshes on empty). A pattern pre-seeds the
          // directory search (setQuery re-GETs filtered). No raw LIST is
          // sent here — the directory's own refresh path owns that.
          setSelectedChannel({ networkSlug, channelName: LIST_WINDOW_NAME, kind: "list" });
          if (cmd.pattern !== null && cmd.pattern !== "") {
            void setQuery(networkSlug, cmd.pattern);
          }
          result = { ok: true };
          break;
        }
        case "links": {
          // #238 — /links [<mask>]. Push on the user-level channel; server
          // primes links_pending + emits LINKS upstream. The 364 burst folds
          // server-side and 365 RPL_ENDOFLINKS drains ONE ephemeral
          // `links_bundle` event on the user topic; LinksModal (mounted in
          // Shell, network-scoped) renders the interactive topology map. No
          // focus change + no scrollback rows (mirrors /who + /names). An empty
          // bundle (restricted/oper-only network) still opens the modal to the
          // "hides topology" state. `cmd.pattern` is the optional server mask.
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/links: network not found" };
          await pushLinks(networkId, cmd.pattern); // S6 (#364): await verb-ack
          result = { ok: true };
          break;
        }
        // #581 — /recover [network]: guided "recover my identity". Push on the
        // user-level channel; the server runs the NickServ recovery sequence and
        // streams recover_progress / recover_result events on the user topic
        // (RecoverModal mirrors them). The modal opens off the SERVER's first
        // recover_progress — NOT optimistically here (cic never originates
        // state). Bare /recover uses the active window's network. A rejection
        // (nothing_to_recover / already_identified / not_visitor) maps to
        // friendly copy; anything else (no_session, WS-down) delegates to the
        // shared friendlyError catch.
        case "recover": {
          const targetSlug = cmd.network ?? networkSlug;
          const networkId = networkIdBySlug(targetSlug);
          if (networkId === undefined) return { error: "/recover: network not found" };
          try {
            await pushRecover(networkId);
          } catch (e) {
            // #581 — the recover rejection tokens (nothing_to_recover /
            // already_identified / recovery_in_progress / forbidden) are now
            // in the generated channel-error union, so `friendlyError` →
            // `friendlyChannelError` owns the copy. No local bridge needed.
            return { error: friendlyError(e) };
          }
          result = { ok: true };
          break;
        }
        // P-0d — /lusers [<mask> [<server>]]. Pushes on user-level channel;
        // server emits the 7-numeric LUSERS bundle. cic dispatches the
        // typed `:lusers_bundle` wire event in userTopic.ts and renders
        // the LusersCard pinned at the top of the current window (#231).
        // #579 — the mask + target server ride along (they were dropped at
        // the parser, so a routed request silently answered from the local
        // server and any mask never reached the wire at all).
        case "lusers": {
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/lusers: network not found" };
          // #248 — mark the request solicited BEFORE pushing so the
          // incoming bundle surfaces the card. The store's gate drops
          // any unsolicited bundle (the Bahamut connect-welcome
          // auto-emit), so an operator /lusers that skipped this mark
          // would show nothing.
          markLusersRequested(networkSlug);
          await pushLusers(networkId, cmd.mask, cmd.server); // S6 (#364): await verb-ack
          result = { ok: true };
          break;
        }
        // #127 — /info, /version, /motd. No-arg server-text queries; server
        // primes the matching accumulator + emits the command, the reply
        // burst drains a typed `server_reply` event that userTopic.ts routes
        // into the serverReplyModal store (ServerReplyModal renders it).
        case "info": {
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/info: network not found" };
          await pushInfo(networkId); // S6 (#364): await verb-ack
          result = { ok: true };
          break;
        }
        case "version": {
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/version: network not found" };
          await pushVersion(networkId); // S6 (#364): await verb-ack
          result = { ok: true };
          break;
        }
        case "motd": {
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/motd: network not found" };
          // #374 — thread the optional target server through so grappa emits
          // `MOTD <target>` upstream (or bare MOTD when null). A 402
          // ERR_NOSUCHSERVER for an unknown target surfaces via the same
          // server_reply modal, never a wrong-server MOTD.
          await pushMotd(networkId, cmd.target); // S6 (#364): await verb-ack
          result = { ok: true };
          break;
        }
        // #155 — /stats [query] [server] + /rehash. Native parser sugar over
        // the #153-de-gated raw transport (mirrors /quote): build the raw
        // STATS/REHASH frame and ship it via pushRaw. Server routing: the
        // STATS reply family (211-219, 240-250) is server-directed — grappa's
        // numeric_router pins the whole family to the `$server` window as
        // :notice rows via its @active_numerics deny list (#184). Before that
        // fix the terminating 219 RPL_ENDOFSTATS's stats-letter param was
        // mis-read by the scan fallback as a query target, forking a bogus
        // window named after the letter; #155's original "no server change"
        // premise was wrong. REHASH/permission numerics (e.g. 481) land on
        // `$server` too. AWAIT the push so a WS-disconnected / server
        // {:error,_} surfaces as an inline compose error instead of a silent
        // green ✓ (the #154 no-silent-drop lesson).
        case "stats": {
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/stats: network not found" };
          // STATS [query] [server] — omit trailing nulls. IRC STATS is a
          // 2-arg frame; the parser guarantees target is only set when query
          // is, so filtering nulls preserves positional order.
          const line = ["STATS", cmd.query, cmd.target]
            .filter((t): t is string => t !== null)
            .join(" ");
          await pushRaw(networkId, line);
          result = { ok: true };
          break;
        }
        case "rehash": {
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/rehash: network not found" };
          // REHASH [option] — omit a null option (bare /rehash → "REHASH",
          // the default full-config reload). #375: mirror the /stats null
          // filter so the option (MOTD/DNS/GC/…) rides the raw frame instead
          // of being dropped into a bare REHASH.
          const line = ["REHASH", cmd.opt].filter((t): t is string => t !== null).join(" ");
          await pushRaw(networkId, line);
          result = { ok: true };
          break;
        }
        // ---------------------------------------------------------------
        // C2 — /whois <nick>. Push on the user-level channel; the server
        // primes its accumulator and emits WHOIS upstream. The bundle
        // arrives later as `whois_bundle` on the user topic
        // (handled by userTopic.ts → setWhoisBundle). WHOIS with an
        // explicit nick works from any window kind; the bundle render
        // targets the active window at arrival time. (Bare /whois resolves
        // a context default — query partner, or self on any network-scoped
        // window; see resolveBareWhoisNick below.)
        // ---------------------------------------------------------------
        case "whois": {
          // #122 + #132 + #137 — bare /whois (and /w alias) context-default:
          // query window → partner; every other network-scoped window → self.
          const nick = cmd.nick ?? resolveBareWhoisNick("whois");
          if (typeof nick !== "string") return nick;
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/whois: network not found" };
          // #198 — cmd.server is set only for the two-arg `/whois <server>
          // <nick>` form; null for single-arg + bare. The bouncer emits
          // `WHOIS <server> <nick>` upstream when present, plain `WHOIS
          // <nick>` otherwise.
          // S6 (#364): await so a validation reject (e.g. invalid_nick, which
          // fires BEFORE the upstream write → no bundle, no numeric) surfaces
          // inline instead of leaving the operator with nothing.
          await pushWhois(networkId, nick, cmd.server);
          result = { ok: true };
          break;
        }
        // P-0c — /whowas <nick>. Push on the user-level channel; the
        // server primes whowas_pending and emits WHOWAS upstream. The
        // bundle arrives later as `whowas_bundle` on the user topic
        // (handled by userTopic.ts → setWhowasBundle), or as a
        // not_found bundle on 406 ERR_WASNOSUCHNICK.
        case "whowas": {
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/whowas: network not found" };
          await pushWhowas(networkId, cmd.nick); // S6 (#364): await verb-ack
          result = { ok: true };
          break;
        }
        // ---------------------------------------------------------------
        // #356 — keyword highlight (/hilight add, /dehilight del; /highlight
        // alias). Routed through the highlightList store so the command AND
        // the watch-lists settings section share ONE authoritative list
        // (the server round-trip returns {patterns}, mirrored into the
        // store). The full post-mutation list renders inline as a green
        // auto-dismissing notice (ComposeBox #356) — the response IS the
        // list, so this is race-free.
        // ---------------------------------------------------------------
        case "watchlist": {
          const patterns =
            cmd.action === "add"
              ? await addHighlight(cmd.pattern)
              : await delHighlight(cmd.pattern);
          result = {
            ok: `highlight (${patterns.length}): ${patterns.join(", ") || "(empty)"}`,
          };
          break;
        }
        // #247/#356 — /notify + /watch presence watch (irssi-direct add).
        // POST to the per-network REST surface; the server broadcasts the
        // updated notify_list + live-syncs the session's MONITOR/WATCH. The
        // green confirmation names the nicks from the COMMAND input, not the
        // store — the notify_list broadcast that would let us re-render the
        // full list may not have landed by the time the POST resolves, so
        // reading watchByNetwork() here would race. Removal is the settings
        // × (bare /notify opens it). Per-network: the active window's network.
        case "notify": {
          if (networkIdBySlug(networkSlug) === undefined)
            return { error: "/notify: network not found" };
          await postNotifyAdd(t, networkSlug, cmd.nicks);
          result = { ok: `notify: watching ${cmd.nicks.join(", ")}` };
          break;
        }
        // #356 — a bare watch-family verb (/notify, /watch, /hilight,
        // /highlight, /dehilight) opens the unified watch-lists settings
        // section rather than printing inline. Opening the drawer IS the
        // feedback, so this is a silent success.
        case "open-settings": {
          requestOpenSettings(cmd.section);
          result = { ok: true };
          break;
        }
        // Bundle C (#20 follow-up) — /quote <raw IRC line>. Push to
        // GrappaChannel.handle_in("raw", _); server validates CRLF/NUL
        // then ships verbatim to the upstream socket. AWAIT the push
        // so disconnected/error replies surface as inline compose-box
        // alerts (no silent green ✓ on a dropped escape-hatch frame).
        case "quote": {
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/quote: network not found" };
          await pushRaw(networkId, cmd.line);
          result = { ok: true };
          break;
        }
        // Bundle C (#20 follow-up) — /oper <name> <password>. The password
        // travels over the WS frame; bouncer redacts it from logs by
        // emitting a static log body before sending OPER upstream.
        // Result lands as a 381 RPL_YOUREOPER (success) / 491 (bad host)
        // / 464 (bad pw) numeric — the existing numeric-routing path
        // persists those as :notice rows. AWAIT the push: a credential-
        // bearing verb MUST NOT silently no-op when the WS is down or
        // the server-side validator rejects (CLAUDE.md
        // `feedback_no_silent_drops_closed`).
        case "oper": {
          const networkId = networkIdBySlug(networkSlug);
          if (networkId === undefined) return { error: "/oper: network not found" };
          await pushOper(networkId, cmd.name, cmd.password);
          result = { ok: true };
          break;
        }
        // #385 — /alias <name> <expansion> defines/overwrites a user alias.
        // Round-tripped through the aliasList store (full-map PUT, server
        // normalizes + validates); a 422 (bad name/expansion, cap exceeded)
        // is thrown as an ApiError and surfaces via friendlyError in the
        // catch below with the per-field message. The green confirmation
        // echoes the normalized definition.
        case "alias-define": {
          await addAlias(cmd.name, cmd.expansion);
          result = { ok: `alias: /${cmd.name} → ${cmd.expansion}` };
          break;
        }
        // #385 — /unalias <name> removes a user alias.
        case "unalias": {
          await delAlias(cmd.name);
          result = { ok: `alias: removed /${cmd.name}` };
          break;
        }
        // ---------------------------------------------------------------
        // Parser-level error (unknown verb or validation failure).
        // ---------------------------------------------------------------
        case "error":
          return { error: cmd.message };
        default: {
          const _exhaustive: never = cmd;
          void _exhaustive;
          return { error: "unhandled" };
        }
      }
    } catch (e) {
      // REST/PubSub failure surfaces here. The pump hands the text back to
      // the composer on this {error}, so the user can retry without
      // re-typing; the {error} arm fires the ComposeBox alert banner.
      //
      // U-3 (UD3): typed ApiErrors get the shared `friendlyApiError`
      // copy treatment so /connect failures (network_busy,
      // too_many_sessions, network_unreachable, ...) render the same
      // human copy as the Login banner does, instead of leaking the
      // raw snake_case wire token into operator-visible alerts.
      // `feedback_no_localized_strings_server_side`.
      //
      // Issue #62: channel-push rejections (ChannelPushError — `/away`
      // set/unset) get the sibling `friendlyChannelError` treatment.
      // Pre-fix every channel-push error collapsed into the generic
      // "send failed" string, swallowing the real reason (the live
      // incident: a visitor's `/away` showed "Send failed" with no clue).
      return { error: friendlyError(e) };
    }

    // #356: a string `result.ok` (the /notify + /hilight confirmation /
    // list output) IS now surfaced — ComposeBox routes it through the
    // severity-tagged feedback signal as a green, auto-dismissing
    // `.compose-box-notice` (role=status). `result.ok: true` is a silent
    // success. (Pre-#356 this string was computed then discarded: CP13
    // removed the numericInline row that used to render it and never
    // rewired a consumer — the gap #356 closed.)
    return result;
  };

  // #904 — the pump. Submitting is now two distinct jobs, and this owns the
  // one `dispatchDraft` must not: the composer buffer.
  //
  //   * IDLE — take the text out (it leaves the composer AT DISPATCH, not on
  //     the 201: that clear-at-ack is what wiped the operator's next message),
  //     dispatch it, then keep dispatching whatever the operator queued behind
  //     it until the slot is empty.
  //   * IN FLIGHT — this Enter is the operator's SECOND message. Park it in
  //     the one-deep slot; the in-flight pump picks it up on the ack. Enter
  //     means something again during a slow send, which is half the defect.
  //   * QUEUE FULL — refuse, and leave the text in the composer where the
  //     operator can see it (ComposeBox turns the textarea readOnly at the
  //     same moment, so this is the belt to that pair of braces: Enter still
  //     fires on a readOnly textarea, and on a remounted ComposeBox).
  //
  // The whole chain settles on the FIRST Enter's promise, so a queued line
  // that dies still surfaces its error to a caller that is watching.
  const submit = async (
    key: ChannelKey,
    networkSlug: string,
    channelName: string,
  ): Promise<SubmitResult> => {
    // #737 — a drain already owns this window's draft, and that draft holds
    // the residue it has NOT sent yet. Re-submitting would fan the same
    // remainder out a second time (the #666 duplicate this whole mechanism
    // exists to prevent) and hand two drains one lock, so the first to finish
    // would unlock a window the other is still rewriting. The guard lives
    // here, not in ComposeBox: that component's `sending()` dies with it, and
    // it unmounts whenever the operator visits home / mentions / $list or the
    // desktop↔mobile layouts swap — after which Enter (keydown still fires on
    // a readOnly textarea) started a fresh drain.
    if (isDraining(key)) return { error: "still sending the previous paste" };

    if (isSending(key)) {
      if (isQueueFull(key)) {
        return { error: "one message is already waiting — hold on until it goes out" };
      }
      // A blank Enter is the same no-op it is anywhere else; it must not
      // burn the slot and lock the composer for nothing.
      if (getDraft(key).trim() === "") return { error: "empty" };
      setOutbox(key, { queued: takeDraft(key) });
      return { ok: true };
    }

    setOutbox(key, { queued: null });
    // Whatever the pump is holding when it leaves. A dead link fires nothing
    // further: the queued line is handed back unsent rather than delivered
    // minutes late, and it comes back AFTER the line that failed — the order
    // they were typed in.
    let inHand: string | null = null;
    try {
      let text = takeDraft(key);
      for (;;) {
        inHand = text;
        const outcome = await dispatchDraft(key, networkSlug, channelName, text);
        // A drain that kept the buffer already put its own residue there.
        inHand = "error" in outcome && !("keptBuffer" in outcome) ? text : null;
        if ("error" in outcome) return outcome;
        const queued = takeQueued(key);
        if (queued === null) return outcome;
        text = queued;
      }
    } finally {
      // …including the exit nobody plans for. `dispatchDraft` catches around
      // its dispatch switch, but the parse ahead of it is outside that net,
      // and the pump owes the composer its text back on EVERY path — a throw
      // that evaporated it would be this issue's own defect, wearing a stack
      // trace. The throw still propagates; only the text is rescued.
      const owed = inHand === null ? [] : [inHand];
      const queued = takeQueued(key);
      if (queued !== null) owed.push(queued);
      handBack(key, owed);
      setOutbox(key, null);
    }
  };

  // #30 — the channel candidate set: every channel JOINED on the same
  // network as the window being typed in. Derived from the server-owned
  // `windowStateByChannel` projection (no parallel client-side list to
  // drift); a pending / invited / parked / failed / kicked window is NOT
  // offered, mirroring the nick rule that you complete who is actually
  // here. Scope is deliberately narrower than the issue's "optionally
  // channels seen via /list or mentioned in the buffer" — those are a
  // separate cut. The decoded name is already ASCII-folded (channelKey
  // folds at construction) and for channels the folded key IS the display
  // (the #537/#525 channel invariant), so it is inserted verbatim.
  //
  // No sigil filter on the candidate name: this map mirrors the server's
  // `Session.Server` `window_states`, which is channel-keyed by
  // construction (a DM lives in `queryWindows`, not here), so a
  // "joined" non-channel key cannot occur. A guard for it was written,
  // measured against the suite at ZERO failing tests, and deleted.
  const joinedChannelsOnNetwork = (key: ChannelKey): string[] => {
    const here = decodeChannelKey(key);
    if (here === null) return [];
    const states = windowStateByChannel();
    const out: string[] = [];
    for (const [candidate, state] of Object.entries(states)) {
      if (state !== "joined") continue;
      const there = decodeChannelKey(candidate as ChannelKey);
      if (there === null || there.slug !== here.slug) continue;
      out.push(there.name);
    }
    return out;
  };

  // Tab-complete. Cycles matches for the word at the cursor, irssi-style.
  // Cycle space is [match0 … matchN-1, <typed>]: after the last match the
  // next forward step restores the originally-typed text, then wraps to
  // match0. Writes the completed draft itself via writeState (NOT setDraft,
  // which nulls tabCycle and would kill the cycle) — callers only place the
  // caret. Returns the new input + caret, or null when there's nothing to
  // complete.
  //
  // #30 — the token's leading sigil picks the candidate SET (channels vs
  // members) and the suffix; the cycle, the revert slot and the anchor are
  // shared. There is ONE completion engine, deliberately: a parallel one
  // would drift on the re-tap/anchor rules that took #737 to get right.
  const tabComplete = (
    key: ChannelKey,
    input: string,
    cursor: number,
    forward: boolean,
  ): { newInput: string; newCursor: number } | null => {
    // #737 — tab-complete writes the draft directly (see writeState below),
    // so it needs the same refusal as setDraft / the history walk.
    if (isDraining(key)) return null;

    const continuing =
      tabCycle !== null &&
      tabCycle.key === key &&
      cursor >= tabCycle.anchorStart &&
      cursor <= tabCycle.anchorEnd &&
      input.slice(tabCycle.anchorStart, tabCycle.anchorEnd) === tabCycle.lastInsertion;

    let anchorStart: number;
    let typedWord: string;
    let prefix: string;
    let suffix: string;
    let oldEnd: number;

    if (continuing && tabCycle !== null) {
      anchorStart = tabCycle.anchorStart;
      typedWord = tabCycle.typedWord;
      prefix = tabCycle.prefix;
      suffix = tabCycle.suffix;
      oldEnd = tabCycle.anchorEnd;
    } else {
      // Fresh cycle: find the word ending at the cursor.
      let start = cursor;
      while (start > 0 && !/\s/.test(input[start - 1] ?? "")) start -= 1;
      typedWord = input.slice(start, cursor);
      if (typedWord.length === 0) return null;
      anchorStart = start;
      // ASCII fold (not a bare toLowerCase) so `Foo` completes a member
      // `foo` — bahamut is CASEMAPPING=ascii (#525), folding `A-Z` ONLY.
      // `[ ] \ ~` are NOT folded, so `foo{` does NOT complete `Foo[1]`
      // (they are DISTINCT nicks). toLowerCase is avoided because it
      // Unicode-over-folds non-ASCII (`CAFÉ`→`café`), not the brackets.
      // Mirror of `Grappa.IRC.Identifier.canonical_nick/1`.
      prefix = asciiFold(typedWord);
      // ": " only when the word is the first token on the line — and only
      // for a NICK. A channel is a topic of conversation, never an
      // addressee, so `#chan: ` would be wrong at line start (#30).
      suffix =
        !CHANNEL_SIGIL.test(typedWord) && input.slice(0, anchorStart).trim() === "" ? ": " : " ";
      oldEnd = cursor;
    }

    const isChannel = CHANNEL_SIGIL.test(typedWord);
    const candidates = isChannel
      ? joinedChannelsOnNetwork(key)
      : (membersByChannel()[key] ?? []).map((m) => m.nick);
    const byName = (a: string, b: string) => a.localeCompare(b);
    const literal = candidates.filter((c) => asciiFold(c).startsWith(prefix)).sort(byName);
    // Second level (#1003), nicks only: the same prefix test with the
    // decoration removed from BOTH sides. It runs AFTER the literal
    // matches — the order IS the behaviour, so with `omino` and `_oMiNo_`
    // both present the first Tab still yields the literal `omino`. A
    // decoration-only word (`_`) strips to nothing and would match every
    // member, so it stays on the literal level. The channel branch never
    // strips: `#foo-bar` is a DIFFERENT channel from `#foobar`.
    const looseWord = isChannel ? "" : stripNickDecoration(prefix);
    const loose =
      looseWord === ""
        ? []
        : candidates
            .filter(
              (c) =>
                !literal.includes(c) && stripNickDecoration(asciiFold(c)).startsWith(looseWord),
            )
            .sort(byName);
    const matches = [...literal, ...loose];
    if (matches.length === 0) return null;

    const span = matches.length + 1; // matches + the revert slot
    const idx =
      continuing && tabCycle !== null
        ? (((tabCycle.idx + (forward ? 1 : -1)) % span) + span) % span
        : 0;

    // idx === matches.length is the revert slot: restore the typed text.
    const insertion = idx === matches.length ? typedWord : matches[idx] + suffix;
    const newInput = input.slice(0, anchorStart) + insertion + input.slice(oldEnd);
    const anchorEnd = anchorStart + insertion.length;

    tabCycle = {
      key,
      typedWord,
      prefix,
      idx,
      anchorStart,
      anchorEnd,
      lastInsertion: insertion,
      suffix,
    };
    writeState(key, (s) => ({ ...s, draft: newInput }));
    return { newInput, newCursor: anchorEnd };
  };

  return {
    composeByChannel,
    getDraft,
    setDraft,
    recallPrev,
    recallNext,
    submit,
    tabComplete,
    isDraining,
    isSending,
    isQueueFull,
  };
});

export const composeByChannel = exports_.composeByChannel;
export const getDraft = exports_.getDraft;
export const setDraft = exports_.setDraft;
export const recallPrev = exports_.recallPrev;
export const recallNext = exports_.recallNext;
export const submit = exports_.submit;
export const tabComplete = exports_.tabComplete;
export const isDraining = exports_.isDraining;
export const isSending = exports_.isSending;
export const isQueueFull = exports_.isQueueFull;
