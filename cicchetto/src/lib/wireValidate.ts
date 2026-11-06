// #429 — the interpreter for the generated runtime wire schemas.
//
// ## Why this exists
//
// `wireTypes.ts` is the codegen mirror of the server's `Grappa.*.Wire`
// typespecs, and `tsc` erases every line of it. So the only thing actually
// standing at the WS/REST boundary was `wireNarrow.ts` + `wireTypesAssert.ts`
// + the inline narrowers in `api.ts` — ~1250 hand-written lines
// re-transcribing, by hand, the very typespecs the codegen already reads.
// Two hand-maintained copies of one authoritative source; the hand copy is
// the one that can silently lose an arm (and did — see `web_session_severed`
// in `wireNarrow.ts`'s history).
//
// `wireSchema.ts` emits those same typespecs as runtime data. This module is
// the ~100 lines that read it. A new server-side Wire type therefore arrives
// with its runtime validation already written.
//
// ## What it does NOT decide
//
// A narrower is not just types — it is the defence at the boundary, and part
// of that defence is a judgement call the typespec cannot express:
//
//   * a DEFAULT that rescues an event instead of dropping it (an unknown
//     `window_counts.severity` must not null the counts);
//   * a TOLERANCE toward a payload minted by a peer of a different vintage
//     (cic deploys independently of the server);
//   * whether a given arm is load-bearing or a detail.
//
// Those stay hand-written at the call site, named as policy. What this file
// removes is the mechanical part: field presence, primitive kinds, closed
// sets, nullability, arrays, nesting. See the per-call-site notes in
// `wireNarrow.ts`.
//
// ## The additive-only contract
//
// An object node copies ONLY the fields the schema declares and ignores
// every other key. An unknown field is never fatal, in either direction —
// that is the wire contract (CLAUDE.md, GH #447), and it is enforced here
// once rather than re-argued in each hand-written arm.

import { noKeys, setKey } from "./byKey";

/**
 * A node of the generated schema grammar. Mirrors the emission in
 * `Mix.Tasks.Grappa.GenWireTypes.schema_ir/2` — change one, change both
 * (the codegen's own moduledoc carries the same grammar).
 */
export type WireNode =
  | "s"
  | "i"
  | "b"
  | "x"
  | "z"
  | { readonly l: string | boolean }
  | { readonly e: readonly string[] }
  | { readonly a: WireNode }
  | { readonly r: WireNode }
  | { readonly p: readonly WireNode[] }
  | { readonly u: readonly WireNode[] }
  | { readonly o: { readonly [key: string]: WireNode }; readonly q?: readonly string[] };

/**
 * The TypeScript type a schema node validates to. Lets a call site assert —
 * at compile time — that the schema it validates against and the generated
 * type it claims to produce are the same shape. Both come out of one codegen
 * run, so a mismatch means the interpreter drifted from the emitter, and
 * that is exactly what the assert is for.
 */
export type Infer<N, D extends Depth = 9> = [D] extends [never]
  ? unknown
  : N extends "s"
    ? string
    : N extends "i"
      ? number
      : N extends "b"
        ? boolean
        : N extends "x"
          ? unknown
          : N extends "z"
            ? null
            : N extends { l: infer L }
              ? L
              : N extends { e: readonly (infer E)[] }
                ? E
                : N extends { a: infer A }
                  ? Infer<A, Prev[D]>[]
                  : N extends { r: infer R }
                    ? Record<string, Infer<R, Prev[D]>>
                    : N extends { p: infer P extends readonly unknown[] }
                      ? { -readonly [K in keyof P]: Infer<P[K], Prev[D]> }
                      : N extends { u: readonly (infer U)[] }
                        ? Infer<U, Prev[D]>
                        : N extends { o: infer O; q: readonly (infer Q extends string)[] }
                          ? InferObject<O, Q, Prev[D]>
                          : N extends { o: infer O }
                            ? InferObject<O, never, Prev[D]>
                            : never;

// `WireNode` is recursive, so `Infer<N>` under an `N extends WireNode`
// constraint is too (TS2589 — "excessively deep"). The fuel counter bounds
// it. Nine levels is far past anything a JSON wire shape reaches; a schema
// that hit the floor would degrade to `unknown` at the leaf rather than fail
// to compile, and the runtime walk is unaffected either way.
type Depth = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
type Prev = [never, 0, 1, 2, 3, 4, 5, 6, 7, 8];

type InferObject<O, Q extends string, D extends Depth> = {
  -readonly [K in Exclude<keyof O, Q>]: Infer<O[K], D>;
} & {
  -readonly [K in Extract<keyof O, Q>]?: Infer<O[K], D>;
};

// `null` is a legal validated value (`"z"`, and every `T | null` field), so
// failure cannot be signalled with it. A module-private sentinel keeps the
// public surface at one function returning `T | null`, which is the shape
// every existing narrower already speaks.
const REJECT = Symbol("wireValidate.reject");

/**
 * Where a payload diverged from its schema, in terms a reader can act on.
 *
 * Issue 2199: a REST mismatch used to reach the user as "the server sent a
 * subject profile this version of the app cannot read" and nothing else. The
 * walk knew the field and threw it away one frame later.
 *
 * ## The payload is not printed, on purpose
 *
 * `got` is the JSON TYPE that arrived, never the value. This text is rendered
 * in the boot-failure modal, which a self-hoster screenshots into a public
 * issue, and it is `console.error`-ed; a wire shape may carry a token or a
 * signed URL. The rule: the SCHEMA is ours and is printed (`expected` spells
 * out a declared literal or closed set), the PAYLOAD is not ours and is not.
 * The cost is that an enum mismatch reads `got string` and the reader opens
 * the network tab for the value — accepted, because the likeliest field case
 * is an absent key, which `got: "absent"` diagnoses completely.
 */
export type WireMismatch = {
  /** Dotted path from the root of the shape, `""` for the root node itself. */
  readonly path: string;
  /** What the schema declares there. */
  readonly expected: string;
  /** The JSON type that arrived, or `"absent"` for an omitted required key. */
  readonly got: string;
};

/** The outcome of a validation that is asked WHY, not just whether. */
export type WireValidation<N> =
  | { readonly ok: true; readonly value: Infer<N> }
  | { readonly ok: false; readonly mismatch: WireMismatch };

/** One line naming the field, what was declared, and what arrived. */
export function describeMismatch(mismatch: WireMismatch): string {
  const where = mismatch.path === "" ? "(root)" : mismatch.path;
  return `${where}: expected ${mismatch.expected}, got ${mismatch.got}`;
}

// The walk records its rejection on the way OUT: the leaf that rejects writes
// `expected`/`got` into these slots, and every frame it unwinds through pushes
// its own segment. Segments therefore arrive leaf-first and are reversed at
// the door.
//
// Module-level and mutable BECAUSE the walk is synchronous and single-
// threaded: there is nothing to interleave with. The alternative — threading a
// path array down through every frame — does its bookkeeping on the path that
// SUCCEEDS, which is the one `validate` runs on every WS event; this way no
// allocation happens per field on the success path. Not measured; it is the
// structure that differs, not a benchmarked number.
//
// Stale records cannot shadow a real one: EVERY rejection originates at a
// `reject()` call, and `reject()` clears the segments. A union arm that failed
// before a later arm succeeded leaves a record behind, and the next genuine
// rejection anywhere overwrites it wholesale.
let rejectionSegments: string[] = [];
let rejectionExpected = "";
let rejectionGot = "";
// How many fields of the OUTERMOST object frame were consumed before it gave
// up. Only `walkUnion` reads it, to tell an arm the payload never meant to be
// (dead at field 0, its `kind` discriminator) from the arm it was trying to be
// (dead further in). Every object frame writes it as REJECT unwinds and the
// outermost writes last, which is the frame whose field order describes the
// arm. Failure path only.
let rejectionProgress = 0;

function reject(expected: string, got: string): typeof REJECT {
  rejectionSegments = [];
  rejectionExpected = expected;
  rejectionGot = got;
  rejectionProgress = 0;
  return REJECT;
}

/**
 * Validate `raw` against a generated schema node.
 *
 * Returns the value typed as the schema describes, or `null` when the payload
 * does not match. Top-level wire shapes are objects (or unions of objects),
 * so `null` is unambiguous there; a nested nullable field is handled inside
 * the walk, where the sentinel keeps the two apart.
 *
 * This is the door for the WS narrowers, which drop an unreadable event and
 * carry on (unknown-is-never-fatal). A caller that must THROW wants
 * `validateDetailed` — same walk, but it hands back the reason.
 */
export function validate<const N extends WireNode>(node: N, raw: unknown): Infer<N> | null {
  const out = walk(node, raw);
  return out === REJECT ? null : (out as Infer<N>);
}

/**
 * `validate`, plus the reason it said no.
 *
 * Two doors for two questions, not two answers to one: the WS boundary asks
 * "does it match" and drops the event either way, while the REST boundary
 * THROWS and therefore owes whoever hits it the name of the field. One walk
 * serves both — the reason costs nothing until a payload is actually bad.
 */
export function validateDetailed<const N extends WireNode>(
  node: N,
  raw: unknown,
): WireValidation<N> {
  const out = walk(node, raw);
  if (out !== REJECT) return { ok: true, value: out as Infer<N> };
  return {
    ok: false,
    mismatch: { path: joinPath(rejectionSegments), expected: rejectionExpected, got: rejectionGot },
  };
}

// Segments carry their own separator so an index does not get a stray dot in
// front of it. Record keys on this wire are channel names and nicks, so the
// non-identifier case is routine rather than exotic: `messages["#grappa"].body`
// reads, `messages.#grappa.body` does not.
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function keySegment(key: string): string {
  return IDENTIFIER.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

function joinPath(segments: readonly string[]): string {
  let out = "";
  for (let i = segments.length - 1; i >= 0; i--) out += segments[i];
  return out.startsWith(".") ? out.slice(1) : out;
}

function describeGot(raw: unknown): string {
  if (raw === null) return "null";
  if (Array.isArray(raw)) return "array";
  return typeof raw;
}

/** What the schema declares at a node, spelled for a human. */
function describeNode(node: WireNode): string {
  if (typeof node === "string") {
    switch (node) {
      case "s":
        return "string";
      case "i":
        return "number";
      case "b":
        return "boolean";
      case "z":
        return "null";
      case "x":
        return "anything";
    }
  }
  if ("l" in node) return `the literal ${JSON.stringify(node.l)}`;
  if ("e" in node) return `one of ${node.e.map((v) => JSON.stringify(v)).join(" | ")}`;
  if ("a" in node) return "array";
  if ("r" in node) return "object";
  if ("p" in node) return `tuple of ${node.p.length}`;
  if ("u" in node) return `one of ${node.u.length} variants`;
  return "object";
}

function walk(node: WireNode, raw: unknown): unknown | typeof REJECT {
  if (typeof node === "string") return walkScalar(node, raw);
  if ("l" in node) return raw === node.l ? raw : reject(describeNode(node), describeGot(raw));
  if ("e" in node) {
    return typeof raw === "string" && node.e.includes(raw)
      ? raw
      : reject(describeNode(node), describeGot(raw));
  }
  if ("a" in node) return walkArray(node.a, raw);
  if ("r" in node) return walkRecord(node.r, raw);
  if ("p" in node) return walkTuple(node.p, raw);
  if ("u" in node) return walkUnion(node.u, raw);
  return walkObject(node.o, node.q, raw);
}

function walkScalar(node: "s" | "i" | "b" | "x" | "z", raw: unknown): unknown | typeof REJECT {
  switch (node) {
    case "s":
      return typeof raw === "string" ? raw : reject("string", describeGot(raw));
    case "i":
      return typeof raw === "number" ? raw : reject("number", describeGot(raw));
    case "b":
      return typeof raw === "boolean" ? raw : reject("boolean", describeGot(raw));
    case "z":
      return raw === null ? null : reject("null", describeGot(raw));
    // `term()` on the server — the field is carried through unvalidated
    // BECAUSE the typespec declines to describe it, not as a shortcut.
    case "x":
      return raw;
  }
}

function walkArray(inner: WireNode, raw: unknown): unknown | typeof REJECT {
  if (!Array.isArray(raw)) return reject("array", describeGot(raw));
  const out: unknown[] = [];
  for (let i = 0; i < raw.length; i++) {
    const v = walk(inner, raw[i]);
    if (v === REJECT) {
      rejectionSegments.push(`[${i}]`);
      return REJECT;
    }
    out.push(v);
  }
  return out;
}

// A record's keys are data (a nick, a window), so its entries are set as own
// properties (issue 2453).
function walkRecord(inner: WireNode, raw: unknown): unknown | typeof REJECT {
  if (!isPlainObject(raw)) return reject("object", describeGot(raw));
  const out = noKeys<unknown>();
  for (const [k, el] of Object.entries(raw)) {
    const v = walk(inner, el);
    if (v === REJECT) {
      rejectionSegments.push(keySegment(k));
      return REJECT;
    }
    setKey(out, k, v);
  }
  return out;
}

function walkTuple(members: readonly WireNode[], raw: unknown): unknown | typeof REJECT {
  if (!Array.isArray(raw)) return reject(`tuple of ${members.length}`, describeGot(raw));
  if (raw.length !== members.length) {
    return reject(`tuple of ${members.length}`, `tuple of ${raw.length}`);
  }
  const out: unknown[] = [];
  for (let i = 0; i < members.length; i++) {
    const v = walk(members[i] as WireNode, raw[i]);
    if (v === REJECT) {
      rejectionSegments.push(`[${i}]`);
      return REJECT;
    }
    out.push(v);
  }
  return out;
}

// First matching arm wins. Every discriminated union the codegen emits leads
// each arm with its `kind` literal, so a mismatched arm fails on its first
// field and the scan is cheap; an ambiguous union would be a server-side
// modelling bug, not something to resolve by scoring arms here.
//
// When EVERY arm fails, the arm that got FURTHEST is the one reported. Issue
// 2199, and it is not a nicety: `S_MeJSONMeJson` is a union at the root, so
// reporting the union itself would answer "(root): expected one of 2 variants"
// for every unreadable `/me` in the field — true, useless, and the exact
// defect the issue is about.
//
// "Furthest" is fields consumed FIRST, path depth second, and the order
// matters: both arms of `/me` are one field deep at their `kind`, so depth
// alone hands a broken visitor profile the user arm's discriminator and names
// the wrong field with a straight face. Fields consumed separates them —
// the arm whose `kind` matched walks on and dies at the real fault. First arm
// wins a genuine tie (nothing distinguishes them), and when the winner never
// got past its own root the union describes itself, which is then the whole
// truth rather than a guess.
function walkUnion(arms: readonly WireNode[], raw: unknown): unknown | typeof REJECT {
  let best: {
    segments: string[];
    expected: string;
    got: string;
    progress: number;
  } | null = null;
  for (const arm of arms) {
    const v = walk(arm, raw);
    if (v !== REJECT) return v;
    const further =
      best === null ||
      rejectionProgress > best.progress ||
      (rejectionProgress === best.progress && rejectionSegments.length > best.segments.length);
    if (further) {
      best = {
        segments: rejectionSegments.slice(),
        expected: rejectionExpected,
        got: rejectionGot,
        progress: rejectionProgress,
      };
    }
  }
  if (best === null || best.segments.length === 0) {
    return reject(describeNode({ u: arms }), describeGot(raw));
  }
  // Re-seat the winner whole — segments included, so an enclosing frame keeps
  // prepending to a path of the true depth.
  rejectionSegments = best.segments;
  rejectionExpected = best.expected;
  rejectionGot = best.got;
  rejectionProgress = best.progress;
  return REJECT;
}

function walkObject(
  fields: { readonly [key: string]: WireNode },
  optional: readonly string[] | undefined,
  raw: unknown,
): unknown | typeof REJECT {
  if (!isPlainObject(raw)) return reject("object", describeGot(raw));
  const out: Record<string, unknown> = {};
  let consumed = 0;
  for (const [key, fieldNode] of Object.entries(fields)) {
    const present = raw[key];
    if (present === undefined) {
      // An `optional(:k)` key the server may omit. A REQUIRED key that is
      // absent is a shape mismatch, not a tolerance: the typespec is where
      // the server says which is which. Reported AT the key rather than at
      // this object, because "which key" is the whole question.
      if (optional?.includes(key)) {
        consumed++;
        continue;
      }
      reject(describeNode(fieldNode), "absent");
      rejectionSegments.push(keySegment(key));
      rejectionProgress = consumed;
      return REJECT;
    }
    const v = walk(fieldNode, present);
    if (v === REJECT) {
      rejectionSegments.push(keySegment(key));
      rejectionProgress = consumed;
      return REJECT;
    }
    out[key] = v;
    consumed++;
  }
  // Undeclared keys are dropped, never rejected — additive-only (GH #447).
  return out;
}

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}
