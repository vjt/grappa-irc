// The ONE tab-completion engine (#30, #737, #1003, #1113, #1255, #1861),
// lifted out of `compose.ts` by issue 2375 so the services console prompt can
// complete nicks and channels too. Two doors, one engine: the compose box and
// the `>` prompt each keep their own cycle and their own draft, and pass them
// through here. Candidates are derived from the KEY the door completes
// against — the members of that window plus the channels joined on its
// network — so a door picks its candidate set by picking its key.

import { casemappingForSlug, chantypesForSlug } from "./casemapping";
import { type ChannelKey, decodeChannelKey } from "./channelKey";
import { isChannelName } from "./chantypes";
import { joinedChannelsOnNetwork } from "./joinedChannels";
import { membersByChannel } from "./members";
import { normalizeNick } from "./nickEquals";

// #1003 — IRC nicks wear decoration (`_omino_`, `bob^`, `gio-vanni`), so
// Tab must reach `_omino_` from the bare `omi`. Deliberately NOT taught to
// `normalizeNick`/`asciiFold`: those are protocol IDENTITY (the cic mirror
// of `Grappa.IRC.Identifier.canonical_target/1` and `/2`, shared with
// nickColor / notifyWatch / channelKey / pingCorrelation), and folding `_`
// there would make `foo` and `f_o_o` the SAME person for highlight, colour
// and presence. This one is local to the completion matcher, where a wrong
// guess costs a second Tab, not an identity merge.
const stripNickDecoration = (s: string): string => s.replace(/[[\]\\`_^{|}-]/g, "");

// Tab-complete cycle anchor. Continuation is detected by RANGE, not by
// word equality, so it survives the ": "/" " suffix that sits after the
// caret and a re-tap that lands the caret anywhere inside the inserted
// nick. `suffix` is the persistent positional suffix for the whole cycle;
// `lastInsertion` is the exact text written last (nick+suffix, OR the
// typed word in the revert slot) — the continuation guard compares the
// anchored span against it.
export type TabCycle = {
  key: ChannelKey;
  typedWord: string; // original-case word the user typed; restored in revert slot
  prefix: string; // lowercased typedWord; the match filter
  idx: number; // 0..matches.length; === matches.length is the revert slot
  anchorStart: number;
  anchorEnd: number;
  lastInsertion: string;
  suffix: string; // ": " (line start, addressee doors only) or " "
};

export type TabRequest = {
  key: ChannelKey; // the window whose members + network channels are candidates
  input: string;
  cursor: number;
  forward: boolean; // Tab (true) / Shift+Tab (false)
  cycle: TabCycle | null; // the door's previous step, or null
  addressee: boolean; // a line-start nick gets ": " (compose) or " " (services prompt)
};

export type TabStep = { newInput: string; newCursor: number; cycle: TabCycle };

// Tab-complete. Cycles matches for the word at the cursor, irssi-style.
// Cycle space is [match0 … matchN-1, <typed>]: after the last match the
// next forward step restores the originally-typed text, then wraps to
// match0. PURE with respect to the draft: it returns the new input, the caret
// and the next cycle, and each door writes them where its draft lives (the
// compose store; the services prompt's own signal). Returns null when there
// is nothing to complete.
//
// #30 — the token's leading sigil picks the candidate SET (channels vs
// members) and the suffix; the cycle, the revert slot and the anchor are
// shared. There is ONE completion engine, deliberately: a parallel one
// would drift on the re-tap/anchor rules that took #737 to get right.
export function tabCompleteStep(req: TabRequest): TabStep | null {
  const { key, input, cursor, forward, cycle: tabCycle, addressee } = req;

  // #1255 — completing a CHANNEL vs a NICK is decided by this network's
  // advertised sigils, not the RFC class: on a `CHANTYPES=#` network a
  // `&foo` token completes against members, not channels.
  const tabSlug = decodeChannelKey(key)?.slug ?? "";
  const tabSigils = chantypesForSlug(tabSlug);
  // #1861 — the same per-network resolution for the nick fold. A key that
  // does not decode leaves the slug empty, which resolves to `:ascii`.
  const tabCasemapping = casemappingForSlug(tabSlug);

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
    // Fold with the NETWORK's casemapping (not a bare toLowerCase) so
    // `Foo` completes a member `foo`. On bahamut (`CASEMAPPING=ascii`,
    // #525) that folds `A-Z` ONLY: `[ ] \ ~` are NOT folded, so for
    // IDENTITY `foo{` and `Foo[1]` stay DISTINCT nicks. On an rfc1459
    // network (#1861) they are the SAME nick and the literal level says
    // so. toLowerCase is avoided because it Unicode-over-folds non-ASCII
    // (`CAFÉ`→`café`), not the brackets. Mirror of
    // `Grappa.IRC.Identifier.canonical_target/2`.
    //
    // Careful, this is only HALF the completion rule (#1003): the second
    // level below counts `{ | }` as decoration alongside `[ ] \`, so on
    // an `:ascii` network `foo{<TAB>` CAN still reach `Foo[1]` — strictly
    // BEHIND every literal match, never displacing one. That is not an
    // identity merge and does not soften #525: nothing here is a key, and
    // what gets inserted is always the real nick. Keep both halves stated
    // — a reader who sees only this paragraph will "fix" the second level
    // as a leftover.
    prefix = normalizeNick(typedWord, tabCasemapping);
    // ": " only when the word is the first token on the line — and only
    // for a NICK. A channel is a topic of conversation, never an
    // addressee, so `#chan: ` would be wrong at line start (#30).
    // issue 2375 — and only at a door that has addressees: on the services
    // prompt the line opens with a COMMAND (`INFO vjt`), never a nick.
    suffix =
      addressee && !isChannelName(typedWord, tabSigils) && input.slice(0, anchorStart).trim() === ""
        ? ": "
        : " ";
    oldEnd = cursor;
  }

  const isChannel = isChannelName(typedWord, tabSigils);
  const candidates = isChannel
    ? joinedChannelsOnNetwork(key)
    : (membersByChannel()[key] ?? []).map((m) => m.nick);
  const byName = (a: string, b: string) => a.localeCompare(b);
  const literal = candidates
    .filter((c) => normalizeNick(c, tabCasemapping).startsWith(prefix))
    .sort(byName);
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
              !literal.includes(c) &&
              stripNickDecoration(normalizeNick(c, tabCasemapping)).startsWith(looseWord),
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

  return {
    newInput,
    newCursor: anchorEnd,
    cycle: {
      key,
      typedWord,
      prefix,
      idx,
      anchorStart,
      anchorEnd,
      lastInsertion: insertion,
      suffix,
    },
  };
}
