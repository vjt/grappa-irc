// #1108 — how many IRC frames the current draft will become, and how many
// bytes are left in the one it is filling.
//
// ## What is the server's and what is ours
//
// The BUDGET is the server's. `Grappa.IRC.LineSplit` sizes a fragment as
// `LINELEN - relay_frame_overhead(target)`, where the overhead reserves the
// #246 WORST-CASE relayed source prefix (`:nick!user@host `, at the ceilings
// grappa validates its own identity against). Those ceilings are exactly the
// numbers a second copy gets silently wrong, in the direction that TRUNCATES
// the wire — so cic never computes them. The server publishes
// `frame_budget_base` on `isupport_changed`, and the only arithmetic left
// here is subtracting the byte length of a target string cic already holds
// (`frameBudgetForTarget`) — the overhead is affine in that length, which is
// what makes one per-network scalar enough.
//
// The COUNT is ours, and it is a MIRROR, deliberately: the warning has to be
// on screen BEFORE the POST, so there is no round trip to ask with. What is
// mirrored is `LineSplit`'s chunker — greedy fill to the budget, preferring
// the last ASCII space/tab in the chunk and CONSUMING it (#1109), falling
// back to the byte cut for a token that holds no boundary. A drift between
// the two costs an advisory number that is off by a frame; it can never cost
// a byte, because the split that actually reaches the wire is still the
// server's. That asymmetry is the whole reason this mirror is allowed to
// exist while a mirror of `relay_frame_overhead` is not.
//
// Everything here is pure: no store reads, no DOM. `compose.ts` resolves what
// the draft would actually POST (`draftLines` + `wireBody` — the same calls
// the send path makes), and this module counts it.

import { CTCP_DELIMITER, isCtcpAction, stripCtcpAction } from "./ctcpAction";

// `\x01ACTION ` + the closing `\x01` — the per-fragment envelope the server
// re-adds to EVERY fragment of an action, so it is charged once per frame,
// not once per message. Derived from the same delimiter the composer frames
// with rather than written as `10`.
const CTCP_ACTION_ENVELOPE_BYTES =
  utf8ByteLength(`${CTCP_DELIMITER}ACTION `) + utf8ByteLength(CTCP_DELIMITER);

// #1870 — resolved on FIRST USE, never at import. `Intl.Segmenter` landed in
// Firefox 125; on 115 ESR the constructor is absent, and this used to be a
// top-level `new`. `ComposeBox` imports this module, so the `TypeError` fired
// while the main bundle was still EVALUATING and React never mounted: a frame
// counter cost the whole app a white page. The build target (`es2022`) cannot
// catch that — `Intl.Segmenter` is a LIBRARY feature, not syntax, so no
// transpile step ever looks at it.
//
// `undefined` is "not asked yet" and `null` is "asked, absent": one feature
// test per page, and no ICU segmenter built for a session that never
// overflows a frame.
let graphemeSegmenter: Intl.Segmenter | null | undefined;

/**
 * `body` split into the units the chunker charges bytes for — extended
 * grapheme clusters where the platform can segment, CODE POINTS where it
 * cannot.
 *
 * The fallback keeps surrogate pairs whole (that is what `Array.from`
 * iterates) and is deliberately wrong about exactly two things: a combining
 * sequence and a ZWJ emoji cluster can be counted as several units and so
 * reported as splitting across frames. That is a cost this mirror is allowed
 * to pay — it moves an ADVISORY number, never a byte, because the split that
 * reaches the wire is still `LineSplit`'s — and only on a browser whose own
 * `Intl` cannot do better anyway.
 */
function graphemesOf(body: string): string[] {
  if (graphemeSegmenter === undefined) {
    graphemeSegmenter =
      typeof Intl.Segmenter === "function"
        ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
        : null;
  }
  if (graphemeSegmenter === null) return Array.from(body);
  return [...graphemeSegmenter.segment(body)].map((s) => s.segment);
}

/**
 * Bytes `s` occupies once UTF-8 encoded — what IRC framing counts, as opposed
 * to `String.length`, which counts UTF-16 units. Walks the string instead of
 * round-tripping a `TextEncoder`, because the chunker below asks this per
 * grapheme and an allocation per grapheme is a keystroke-path cost.
 */
export function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i += 1) {
    const unit = s.charCodeAt(i);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      // A well-formed surrogate PAIR is one astral codepoint: 4 bytes, two
      // units. A lone surrogate falls through to 3 — what the encoder emits
      // for the replacement character it substitutes.
      bytes += 4;
      i += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * The per-frame body budget for `target`, from the per-network base the
 * server published. `null` when there is no base (no live session has
 * reported one yet) — the caller must then show no warning at all rather
 * than guess a budget.
 *
 * Also `null` when the frame cannot hold a body at all: a LINELEN small
 * enough to be eaten whole by the relay reserve (an ircd may advertise any
 * positive one) makes this non-positive, and the server's own fast path then
 * sends the body UNSPLIT. Nothing to warn about, nothing to count down — and
 * a negative remainder would render as `--118`.
 */
export function frameBudgetForTarget(base: number | null, target: string): number | null {
  if (base === null) return null;
  const budget = base - utf8ByteLength(target);
  return budget <= 0 ? null : budget;
}

/**
 * How many wire frames `wireBody` — the bytes as they will be POSTed,
 * envelope included — becomes at `budget` bytes per frame.
 */
export function frameCount(wireBody: string, budget: number): number {
  // A budget too small to frame anything: the server sends the body unsplit
  // rather than loop, and so must the number the operator reads.
  if (budget <= 0) return 1;
  if (utf8ByteLength(wireBody) <= budget) return 1;

  if (isCtcpAction(wireBody)) {
    const innerBudget = budget - CTCP_ACTION_ENVELOPE_BYTES;
    if (innerBudget <= 0) return 1;
    return chunkCount(stripCtcpAction(wireBody), innerBudget);
  }

  return chunkCount(wireBody, budget);
}

export type FramePreview = {
  /** Wire frames the whole draft becomes — 0 when there is nothing to send. */
  messages: number;
  /**
   * Bytes still free in the frame. `null` unless the draft is exactly one
   * frame: past that edge the split warning is the honest surface, and a
   * "bytes remaining" number would be about nothing.
   */
  remainingBytes: number | null;
};

/**
 * What the compose box owes the operator about `bodies` — the wire bodies a
 * submit would POST, in order (one per line; `compose.ts` builds them).
 */
export function framePreview(bodies: readonly string[], budget: number): FramePreview {
  const messages = bodies.reduce((total, body) => total + frameCount(body, budget), 0);
  const only = bodies.length === 1 ? bodies[0] : undefined;
  return {
    messages,
    remainingBytes: only !== undefined && messages === 1 ? budget - utf8ByteLength(only) : null,
  };
}

// The mirror of `LineSplit.chunk_by_bytes/5`, counting fragments instead of
// building them. Greedy fill; on overflow the chunk is cut at its last word
// boundary and the overflowing grapheme is RE-READ against the carry-over,
// which may already leave no room for it.
function chunkCount(body: string, budget: number): number {
  const graphemes = graphemesOf(body);
  let chunks = 0;
  let current: string[] = [];
  let size = 0;
  let i = 0;

  while (i < graphemes.length) {
    const grapheme = graphemes[i] ?? "";
    const graphemeSize = utf8ByteLength(grapheme);

    if (graphemeSize > budget) {
      // Indivisible and oversized: the server emits it intact as its own
      // fragment rather than dropping or bisecting it.
      if (current.length > 0) chunks += 1;
      chunks += 1;
      current = [];
      size = 0;
      i += 1;
      continue;
    }

    if (size + graphemeSize > budget) {
      current = carryAfterLastBreak(current);
      chunks += 1;
      size = utf8ByteLength(current.join(""));
      continue;
    }

    current.push(grapheme);
    size += graphemeSize;
    i += 1;
  }

  if (current.length > 0) chunks += 1;
  return chunks === 0 ? 1 : chunks;
}

// What carries over into the next chunk once `current` is cut at its LAST
// word boundary — the boundary grapheme itself is consumed. Empty when there
// is no usable boundary (none at all, or only at the very start, where the
// cut would emit an empty fragment): the whole chunk is then emitted as-is,
// which is the byte cut.
//
// ASCII space and tab only, matching the server: NO-BREAK SPACE and its
// relatives exist to FORBID a break, so counting them as boundaries would
// invert their meaning.
function carryAfterLastBreak(current: readonly string[]): string[] {
  for (let k = current.length - 1; k > 0; k -= 1) {
    if (current[k] === " " || current[k] === "\t") return current.slice(k + 1);
  }
  return [];
}
