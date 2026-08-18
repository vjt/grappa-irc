import { createEffect, createSignal, on } from "solid-js";
import { aliases } from "./aliasList";
import { ownNickForNetwork } from "./api";
import { token } from "./auth";
import { type ChannelKey, channelKey, decodeChannelKey } from "./channelKey";
import { isChannelName } from "./chantypes";
import type { CommandContext, DispatchOutcome, SubmitResult } from "./commands/context";
import { fanOutCommand } from "./commands/fanout";
import { watchlistCommand } from "./commands/highlight";
import {
  aliasDefineCommand,
  errorCommand,
  openSettingsCommand,
  unaliasCommand,
} from "./commands/local";
import {
  banlistCommand,
  modeApplyCurrentCommand,
  modeCommand,
  modeViewCommand,
  umodeCommand,
  umodeTargetViewCommand,
  umodeViewCommand,
} from "./commands/mode";
import { connectCommand } from "./commands/network";
import {
  banCommand,
  deopCommand,
  devoiceCommand,
  inviteCommand,
  kbCommand,
  kickCommand,
  killCommand,
  opCommand,
  unbanCommand,
  voiceCommand,
} from "./commands/ops";
import { ctcpCommand, noticeCommand, pingCommand } from "./commands/relay";
import {
  adminCommand,
  infoCommand,
  linksCommand,
  lusersCommand,
  motdCommand,
  namesCommand,
  quoteCommand,
  rehashCommand,
  statsCommand,
  versionCommand,
  whoCommand,
  whoisCommand,
  whowasCommand,
} from "./commands/server";
import { serviceModalCommand } from "./commands/services";
import {
  awayCommand,
  disconnectCommand,
  nickCommand,
  notifyCommand,
  operCommand,
  quitCommand,
  recoverCommand,
} from "./commands/session";
import { topicClearCommand, topicSetCommand, topicShowCommand } from "./commands/topic";
import { joinCommand, listCommand, partCommand, queryCommand } from "./commands/window";
import { documentTeardownEpoch, documentTornDownSince } from "./documentTeardown";
import { type FramePreview, framePreview } from "./frameBudget";
import { friendlyError } from "./friendlyError";
import { identityScopedStore } from "./identityScopedStore";
import { chantypesForNetwork } from "./isupport";
import { joinedChannelsOnNetwork } from "./joinedChannels";
import { membersByChannel } from "./members";
import { splitMessageLines } from "./messageLines";
import { networkBySlug, networkIdBySlug, user } from "./networks";
import { asciiFold } from "./nickEquals";
import { ensureQueryTopicJoined } from "./queryTopicJoin";
import { canonicalQueryNick, openQueryWindowState } from "./queryWindows";
// #1225 — the seam sends a PRIVMSG to the window OR relays a NOTICE/CTCP to a
// different recipient while echoing here, so it is named for the window, not
// for one of the verbs it can carry.
import { selectedChannel, setSelectedChannel } from "./selection";
import { draftLines, sendBodyLines, wireBody } from "./sendPipeline";
import { isServicesSender } from "./servicesSender";
import { parseSlash } from "./slashCommands";
import { SERVER_WINDOW_NAME } from "./windowKinds";

// #1255 — the channel sigils this NETWORK advertised (005 CHANTYPES),
// falling back to the RFC 2812 class for a network with no live session or
// one that omits the token. This replaced a hardcoded `/^[#&+!]/` whose
// comment named the correct source and admitted nothing in the stack parsed
// it; the widening plumbed it through `isupport_changed`. (The comment used
// to carry a `TODO(#30)`, which pointed at a closed, unrelated issue.)
const sigilsFor = (slug: string): readonly string[] =>
  chantypesForNetwork(networkIdBySlug(slug) ?? null);

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

// #904 — `submit` (the pump) OWNS the composer buffer: it takes the text out
// at dispatch and hands it back if the submission fails, so every failure
// path preserves the draft without each of the ~40 arms knowing about it.
// The multi-line #666 drain is the ONE exception — it claims the buffer
// (#737) and mirrors its own, finer-grained residue into it, so it says
// `keptBuffer` and the pump keeps its hands off instead of dropping the whole
// paste back on top of the remainder.

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

/**
 * #1108 — what the current draft will do to the wire, or `null` when there is
 * nothing honest to say: the server has published no budget for this network
 * (`budget === null`), or the draft is a command that sends no PRIVMSG to
 * `target`. `/msg peer …` is excluded on purpose — it addresses a DIFFERENT
 * target, whose budget is a different number.
 *
 * The `$server` window refuses plain text outright (CP13 S9, the same
 * refusal `submit` returns below), so a draft there is previewed as nothing
 * rather than as a split of a message that will never be sent.
 *
 * Resolved through the same `parseSlash` dispatch, line split and CTCP
 * framing the submit path runs, so the preview is a statement about the bytes
 * that will actually be POSTed rather than about the raw draft.
 */
export const draftFramePreview = (
  target: string,
  draft: string,
  budget: number | null,
): FramePreview | null => {
  if (budget === null) return null;
  const cmd = parseSlash(draft, aliases());
  if (cmd.kind !== "privmsg" && cmd.kind !== "me") return null;
  if (target === SERVER_WINDOW_NAME && cmd.kind === "privmsg") return null;
  const action = cmd.kind === "me";
  return framePreview(
    draftLines(cmd.body).map((line) => wireBody(line, action)),
    budget,
  );
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
    // #1255 — the parser decides "channel or nick?" for /join, /part, /topic
    // and /mode, and that answer is per-network. It stays pure and takes the
    // advertised sigils as data, exactly as it takes the alias map.
    const cmd = parseSlash(text, aliases(), sigilsFor(networkSlug));
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
      // A channel window opens with one of the sigils THIS network
      // advertises. Query windows use a nick; server/list/mentions
      // pseudo-windows use synthetic keys that carry no sigil at all.
      if (!isChannelName(name, sigilsFor(sel.networkSlug))) return null;
      return name;
    };

    // Require a channel window; emit inline error if not in one.
    const requireChannel = (verb: string): string | { error: string } => {
      const ch = getActiveChannel();
      if (!ch) return { error: `/${verb} requires an active channel window` };
      return ch;
    };

    // #1396 — the network twin of requireChannel: a SLUG resolves to the live
    // network id, or to the inline error the operator reads. It carries the
    // one message 35 arms used to spell out for themselves. (A 36th arm
    // resolves a network id and is NOT routed here — bare /query's close path
    // asks about a different network; see the comment there.)
    //
    // Three properties, each of which a "resolve it once at the top" rewrite
    // would quietly drop, and each pinned by a test that fails on the
    // corresponding mutant:
    //
    //   * The slug is a PARAMETER, never `networkSlug` closed over. Two arms
    //     resolve a different one — /recover takes `cmd.network ?? networkSlug`
    //     and bare /query the SELECTED window's, which can diverge from the
    //     submitting one when a submit is queued across a window switch.
    //   * Called FROM the arm, so resolution stays LAZY: 14 arms never ask,
    //     because the REST verbs address the network by slug, and resolving
    //     eagerly would reject submissions that succeed today.
    //   * Called at the arm's own guard position, so the ORDER holds: 13 arms
    //     check `requireChannel` first, and when both would fail the operator
    //     must still see the channel error.
    //
    // `subject` opens the message and is the bare verb at every site it serves.
    const requireNetworkId = (slug: string, subject: string): number | { error: string } => {
      const id = networkIdBySlug(slug);
      if (id === undefined) return { error: `/${subject}: network not found` };
      return id;
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

    // #1396 — the per-submission values a handler cannot import for itself.
    // Built once, here, so every handler reads the SAME window: resolving any
    // of these inside a handler would re-read the store at handler time and
    // could answer for a different window than the one that submitted.
    const ctx: CommandContext = {
      key,
      networkSlug,
      channelName,
      text,
      token: t,
      getActiveChannel,
      sigils: () => sigilsFor(networkSlug),
      requireChannel,
      requireNetworkId,
      resolveBareWhoisNick,
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
        case "ame":
        case "amsg": {
          result = await fanOutCommand(cmd, ctx);
          break;
        }
        case "ctcp": {
          result = await ctcpCommand(cmd, ctx);
          break;
        }
        case "ping": {
          result = await pingCommand(cmd, ctx);
          break;
        }
        case "notice": {
          result = await noticeCommand(cmd, ctx);
          break;
        }
        case "join":
          result = await joinCommand(cmd, ctx);
          break;
        case "part": {
          result = await partCommand(cmd, ctx);
          break;
        }
        case "topic-show":
          return await topicShowCommand(cmd, ctx);
        case "topic-set": {
          result = await topicSetCommand(cmd, ctx);
          break;
        }
        case "topic-clear": {
          result = await topicClearCommand(cmd, ctx);
          break;
        }
        case "nick":
          result = await nickCommand(cmd, ctx);
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
          const networkId = requireNetworkId(networkSlug, "msg");
          if (typeof networkId !== "number") return networkId;
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
          result = await serviceModalCommand(cmd, ctx);
          break;
        }
        case "query": {
          result = await queryCommand(cmd, ctx);
          break;
        }
        case "quit":
          return await quitCommand(cmd, ctx);
        case "disconnect": {
          result = await disconnectCommand(cmd, ctx);
          break;
        }
        case "connect": {
          result = await connectCommand(cmd, ctx);
          break;
        }
        case "away": {
          result = await awayCommand(cmd, ctx);
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
          result = await opCommand(cmd, ctx);
          break;
        }
        case "deop": {
          result = await deopCommand(cmd, ctx);
          break;
        }
        case "voice": {
          result = await voiceCommand(cmd, ctx);
          break;
        }
        case "devoice": {
          result = await devoiceCommand(cmd, ctx);
          break;
        }
        case "kick": {
          result = await kickCommand(cmd, ctx);
          break;
        }
        case "ban": {
          result = await banCommand(cmd, ctx);
          break;
        }
        case "kb": {
          result = await kbCommand(cmd, ctx);
          break;
        }
        case "kill": {
          result = await killCommand(cmd, ctx);
          break;
        }
        case "unban": {
          result = await unbanCommand(cmd, ctx);
          break;
        }
        case "banlist": {
          result = await banlistCommand(cmd, ctx);
          break;
        }
        case "invite": {
          result = await inviteCommand(cmd, ctx);
          break;
        }
        case "umode": {
          result = await umodeCommand(cmd, ctx);
          break;
        }
        case "umode-view": {
          result = await umodeViewCommand(cmd, ctx);
          break;
        }
        case "umode-target-view": {
          result = await umodeTargetViewCommand(cmd, ctx);
          break;
        }
        case "mode": {
          result = await modeCommand(cmd, ctx);
          break;
        }
        case "mode-view": {
          result = await modeViewCommand(cmd, ctx);
          break;
        }
        case "mode-apply-current": {
          result = await modeApplyCurrentCommand(cmd, ctx);
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
          result = await whoCommand(cmd, ctx);
          break;
        }
        case "names": {
          result = await namesCommand(cmd, ctx);
          break;
        }
        case "list": {
          result = await listCommand(cmd, ctx);
          break;
        }
        case "links": {
          result = await linksCommand(cmd, ctx);
          break;
        }
        case "recover": {
          result = await recoverCommand(cmd, ctx);
          break;
        }
        case "lusers": {
          result = await lusersCommand(cmd, ctx);
          break;
        }
        case "info": {
          result = await infoCommand(cmd, ctx);
          break;
        }
        case "version": {
          result = await versionCommand(cmd, ctx);
          break;
        }
        case "motd": {
          result = await motdCommand(cmd, ctx);
          break;
        }
        case "admin": {
          result = await adminCommand(cmd, ctx);
          break;
        }
        case "stats": {
          result = await statsCommand(cmd, ctx);
          break;
        }
        case "rehash": {
          result = await rehashCommand(cmd, ctx);
          break;
        }
        case "whois": {
          result = await whoisCommand(cmd, ctx);
          break;
        }
        case "whowas": {
          result = await whowasCommand(cmd, ctx);
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
          result = await watchlistCommand(cmd, ctx);
          break;
        }
        case "notify": {
          result = await notifyCommand(cmd, ctx);
          break;
        }
        case "open-settings": {
          result = await openSettingsCommand(cmd, ctx);
          break;
        }
        case "quote": {
          result = await quoteCommand(cmd, ctx);
          break;
        }
        case "oper": {
          result = await operCommand(cmd, ctx);
          break;
        }
        case "alias-define": {
          result = await aliasDefineCommand(cmd, ctx);
          break;
        }
        case "unalias": {
          result = await unaliasCommand(cmd, ctx);
          break;
        }
        // Not a verb: the parser's own failure, routed like one.
        case "error": {
          result = await errorCommand(cmd, ctx);
          break;
        }
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
    // #954 — the document-lifecycle epoch as of the dispatch currently in the
    // air, re-sampled per iteration so a teardown can only condemn the line it
    // actually overlapped. Sampled here too, because `takeDraft` throwing would
    // reach the `finally` before the loop ever assigns it.
    let teardownAtDispatch = documentTeardownEpoch();
    try {
      let text = takeDraft(key);
      for (;;) {
        inHand = text;
        teardownAtDispatch = documentTeardownEpoch();
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
      //
      // #954 — with ONE rejection class excepted: the document was destroyed
      // while this line was in the air (a reload, the #674 auto-refresh, a
      // closed tab). That abort is not evidence the send failed — the server
      // may already own the message — and the text does not die with the page
      // either, because #772 mirrors the draft into sessionStorage: handing it
      // back here is what re-arms the composer, after the reload, with a line
      // the channel already shows. So it is DROPPED. The trade is deliberate
      // and it is vjt's (issue #954, 2026-08-08): the echo will render the
      // message, whereas a loaded composer invites a second Enter.
      //
      // WHERE THE TRADE STOPS BEING FREE, measured, not assumed. On the
      // #954 harness (real Bandit listener, real TCP kill at a controlled
      // offset, N=20/row, three runs) an aborted POST persisted 20/20 at every
      // offset from +1ms onward, either close mode — that is the regime this
      // drop is for, and its 95% ceiling on non-persistence is 0.32%. The ONE
      // exception is an RST landing at +0ms after the last body byte: 0/20,
      // the message did NOT land, and dropping the text there LOSES it.
      // Whether a destroyed document closes FIN or RST is UNMEASURED, and a
      // killed tab plausibly looks like RST — so that sub-millisecond window
      // on an otherwise idle path is a real, if narrow, loss. Engineering
      // around it means a delivery-confirmation protocol (an idempotency key
      // on the POST, or a correlation token echoed back), which #954 rules out
      // as its own cluster. Do not paper over it here; widen the measurement
      // first if it ever needs revisiting.
      //
      // The QUEUED line is handed back regardless: it was never dispatched, so
      // no server can own it, and dropping it would lose a message outright.
      //
      // SCOPE, so nobody reads this as covering more than it does: a paced
      // multi-line drain never reaches here with text in hand (`keptBuffer`
      // leaves `inHand` null) because it mirrors its OWN residue into the
      // draft, so an aborted line inside a paste is still re-armed. That is
      // the same hazard at a different writer, and it is NOT the same rule —
      // the drain's error mix includes explicit 429 refusals, which prove the
      // line did not land and must never be dropped. Deliberately left to a
      // decision of its own rather than guessed at here.
      const destroyedInFlight = documentTornDownSince(teardownAtDispatch);
      const owed = inHand === null || destroyedInFlight ? [] : [inHand];
      const queued = takeQueued(key);
      if (queued !== null) owed.push(queued);
      handBack(key, owed);
      setOutbox(key, null);
    }
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

    // #1255 — completing a CHANNEL vs a NICK is decided by this network's
    // advertised sigils, not the RFC class: on a `CHANTYPES=#` network a
    // `&foo` token completes against members, not channels.
    const tabSigils = sigilsFor(decodeChannelKey(key)?.slug ?? "");

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
      // `[ ] \ ~` are NOT folded, so for IDENTITY `foo{` and `Foo[1]` stay
      // DISTINCT nicks. toLowerCase is avoided because it Unicode-over-folds
      // non-ASCII (`CAFÉ`→`café`), not the brackets. Mirror of
      // `Grappa.IRC.Identifier.canonical_nick/1`.
      //
      // Careful, this is only HALF the completion rule (#1003): the second
      // level below counts `{ | }` as decoration alongside `[ ] \`, so
      // `foo{<TAB>` CAN reach `Foo[1]` — strictly BEHIND every literal
      // match, never displacing one. That is not an identity merge and does
      // not soften #525: nothing here is a key, and what gets inserted is
      // always the real nick. Keep both halves stated — a reader who sees
      // only this paragraph will "fix" the second level as a leftover.
      prefix = asciiFold(typedWord);
      // ": " only when the word is the first token on the line — and only
      // for a NICK. A channel is a topic of conversation, never an
      // addressee, so `#chan: ` would be wrong at line start (#30).
      suffix =
        !isChannelName(typedWord, tabSigils) && input.slice(0, anchorStart).trim() === ""
          ? ": "
          : " ";
      oldEnd = cursor;
    }

    const isChannel = isChannelName(typedWord, tabSigils);
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
