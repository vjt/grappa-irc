import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { narrowUserEvent } from "../lib/userTopic";
import * as schemas from "../lib/wireSchema";
import type { DeliberatelyWidened } from "../lib/wireTypesAssert";
import type { WireNode } from "../lib/wireValidate";
import { validate } from "../lib/wireValidate";

// #1393 — the mutate-every-field MEASUREMENT `wireAdminBoundary` applies to
// the admin channel, pointed at the WHOLE user topic.
//
// `userTopic.ts` hand-narrows 42 arms and uses zero generated schemas, while
// a schema for every one of those arms is already emitted next to it. The
// review calls that an arrested migration; this file turns the claim into a
// list. For each arm it synthesises a valid payload from the GENERATED
// schema, mutates it field by field, and records what the hand narrower and
// the schema each do with it. Arms where the two agree are a proved dead end
// — nothing to gain by swapping them.
//
// A disagreement is measured in BOTH directions, because they cost opposite
// things and one alone cannot settle whether an arm is worth migrating:
//
//   * the hand narrower ACCEPTS what the schema rejects — a permissiveness
//     hole, the only place a migration buys safety rather than line count;
//   * the schema ACCEPTS what the hand narrower rejects — strictness the
//     migration would silently LOSE, since the typespec is the looser of the
//     two and swapping in the generated check drops the hand-written guard.
//
// Measuring one direction only would report an asymmetry as a parity.
//
// Arms are matched to schemas by their `kind` LITERAL, not by a camelised
// name: the name heuristic missed three arms whose schema lives under a
// differently-named Wire module.
//
// `kind` is excluded from the mutation matrix on purpose. Mutating the
// discriminator tests DISPATCH, not field validation: the hand narrower
// falls through its switch while the schema rejects a literal mismatch —
// same verdict, different mechanism, no information about the boundary.

type Narrower = (raw: unknown) => unknown;

const hand: Narrower = (raw) => narrowUserEvent(raw);

function sample(node: WireNode): unknown {
  if (typeof node === "string") {
    switch (node) {
      case "s":
        return "sample";
      case "i":
        return 1;
      case "b":
        return true;
      case "z":
        return null;
      case "x":
        return { opaque: true };
    }
  }
  if ("l" in node) return node.l;
  if ("e" in node) return node.e[0];
  if ("a" in node) return [sample(node.a)];
  if ("r" in node) return { key: sample(node.r) };
  if ("p" in node) return node.p.map(sample);
  if ("u" in node) return sample(node.u[0] as WireNode);
  return Object.fromEntries(Object.entries(node.o).map(([k, v]) => [k, sample(v)]));
}

function wrongType(value: unknown): unknown {
  if (typeof value === "string") return 12345;
  if (typeof value === "number") return "12345";
  if (typeof value === "boolean") return "true";
  if (Array.isArray(value)) return "not-an-array";
  return "not-an-object";
}

// The fourth op, and the one the first three cannot express: a leaf of the
// RIGHT type carrying a value the schema does not declare.
//
// `drop`, `null` and `wrong-type` all move the TYPE, so they leave a closed
// set (`{e: [...]}`, `{l: "..."}`) and a free `"s"` indistinguishable — both
// take a string, both refuse a number. But a token a server adds additively
// IS a well-typed string, and that is precisely the case the wire contract
// legislates (unknown-is-never-fatal, GH #447): several hand arms accept any
// string ON PURPOSE where the typespec names a closed set, so that a newer
// BEAM cannot make an older cic drop a terminal event. A type-only matrix
// reports those arms at parity and would wave the migration through.
//
// Generated for STRING leaves only — on any other leaf it would be
// `wrong-type` under a second name — and on a free-string field both
// boundaries accept it, so the row costs a line and says nothing. It is the
// closed-set fields where it separates them.
const UNDECLARED_VALUE = "__undeclared_wire_value__";

// Every position in a sample at which a field can be mutated, as a path.
//
// The matrix that landed with #1471 mutated TOP-LEVEL fields only, and that
// cannot see a tolerance nested inside an object field. `connection_state_changed`
// is the measured instance: its hand arm defaults `network.recoverable` to
// `false` when the server omits it (#581, additive-field tolerance), while
// `S_NetworksWireHomeNetworkRow` declares that field REQUIRED. One level down
// the two boundaries disagree; at the top level they look identical, and the
// arm was therefore counted among the 34 at parity. So the matrix walks the
// whole sample instead of its first layer.
function paths(value: unknown, prefix: readonly string[] = []): string[][] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => [[...prefix, String(i)], ...paths(v, [...prefix, String(i)])]);
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [
      [...prefix, k],
      ...paths(v, [...prefix, k]),
    ]);
  }
  return [];
}

type Op = "drop" | "null" | "wrong-type" | "swap";

const OPS = ["drop", "null", "wrong-type", "swap"] as const;

function mutateAt(root: unknown, path: readonly string[], op: Op) {
  const copy = JSON.parse(JSON.stringify(root));
  let parent = copy;
  for (const k of path.slice(0, -1)) parent = parent[k];
  const leaf = path[path.length - 1] as string;
  if (op === "drop") {
    // Deleting an array index would leave a hole that reads as `undefined`
    // rather than a shorter array, which is a third mutation nobody asked
    // for. Splice keeps "drop" meaning the same thing at every position.
    if (Array.isArray(parent)) parent.splice(Number(leaf), 1);
    else delete parent[leaf];
  } else if (op === "null") {
    parent[leaf] = null;
  } else if (op === "swap") {
    parent[leaf] = UNDECLARED_VALUE;
  } else {
    parent[leaf] = wrongType(parent[leaf]);
  }
  return copy;
}

function valueAt(root: unknown, path: readonly string[]): unknown {
  let node = root;
  for (const k of path) node = (node as Record<string, unknown>)[k];
  return node;
}

type Mutation = { label: string; payload: unknown };

// `kind` is excluded at the TOP level only — mutating the discriminator tests
// dispatch, not field validation. A nested `kind` belongs to a nested shape
// and is an ordinary field there.
function mutations(valid: Record<string, unknown>): Mutation[] {
  return paths(valid)
    .filter((p) => !(p.length === 1 && p[0] === "kind"))
    .flatMap((p) =>
      opsFor(valueAt(valid, p)).map((op) => ({
        label: `${p.join(".")}/${op}`,
        payload: mutateAt(valid, p, op),
      })),
    );
}

function opsFor(leaf: unknown): readonly Op[] {
  return typeof leaf === "string" ? OPS : OPS.filter((op) => op !== "swap");
}

function verdict(narrow: Narrower, payload: unknown): "accept" | "reject" {
  return narrow(payload) === null ? "reject" : "accept";
}

function isObjectNode(node: WireNode): node is { o: Record<string, WireNode> } {
  return typeof node !== "string" && "o" in node;
}

// Key order is not part of the boundary contract, so it must not be part of
// the comparison: an arm that builds `{kind, network}` and a schema that
// declares `{network, kind}` hand the dispatcher the same object.
function canon(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canon);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, canon(v)]),
    );
  }
  return value;
}

function keysOf(value: unknown): string[] {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>).sort()
    : [];
}

// Every generated schema that carries a `kind` literal, indexed by it.
function schemasByKind(): Map<string, Candidate[]> {
  const out = new Map<string, Candidate[]>();
  for (const [name, node] of Object.entries(schemas) as [string, WireNode][]) {
    if (!name.startsWith("S_") || !isObjectNode(node)) continue;
    const k = node.o.kind;
    if (k === undefined || typeof k === "string" || !("l" in k)) continue;
    const list = out.get(k.l as string) ?? [];
    list.push({ name, node });
    out.set(k.l as string, list);
  }
  return out;
}

type Candidate = { name: string; node: WireNode };

type ArmReport = {
  arm: string;
  schema: string;
  mutations: number;
  handAcceptsSchemaRejects: string;
  schemaAcceptsHandRejects: string;
  schemaRejectsValid: boolean;
};

function censusArm(kind: string, schemaName: string, node: WireNode): ArmReport {
  const generated: Narrower = (raw) => validate(node, raw);
  const valid = sample(node) as Record<string, unknown>;
  const matrix = mutations(valid);

  const holes: string[] = [];
  const losses: string[] = [];
  for (const { label, payload } of matrix) {
    const byHand = verdict(hand, payload);
    const bySchema = verdict(generated, payload);
    if (byHand === "accept" && bySchema === "reject") holes.push(label);
    if (bySchema === "accept" && byHand === "reject") losses.push(label);
  }

  return {
    arm: kind,
    schema: schemaName,
    mutations: matrix.length,
    handAcceptsSchemaRejects: holes.length === 0 ? "-" : holes.join(", "),
    schemaAcceptsHandRejects: losses.length === 0 ? "-" : losses.join(", "),
    // The oracle's own sanity check: a schema that rejects its OWN sample
    // means the sampler and the schema disagree, and every verdict on that
    // arm is noise rather than a measurement.
    schemaRejectsValid: verdict(generated, valid) === "reject",
  };
}

const BY_KIND = schemasByKind();
// An ambiguous kind literal (`web_session_severed` is emitted by two Wire
// modules) is kept if ANY of its candidate schemas produces a sample the hand
// narrower accepts — and every candidate is then censused, so the arm cannot
// fall out of the list because the first candidate happened to be the wrong
// module's.
const accepts = (k: string): boolean =>
  candidatesFor(k).some(({ node }) => verdict(hand, sample(node)) === "accept");

const ARMS = [...BY_KIND.keys()];

// Every schema whose `kind` literal is this one. Throws rather than returning
// empty: `ARMS` is derived from the same map, so a miss here would mean the
// map changed under the walk, and a census that silently skipped an arm is
// worse than one that stops.
function candidatesFor(kind: string): [Candidate, ...Candidate[]] {
  const found = BY_KIND.get(kind);
  if (found === undefined || found.length === 0) {
    throw new Error(`no generated schema carries the kind literal "${kind}"`);
  }
  return found as [Candidate, ...Candidate[]];
}

// The control. Two boundaries agreeing means nothing unless the matrix can
// tell them apart, so this one is weakened ON PURPOSE — it skips the `state`
// check — and `state` has to show up as a hole.
const weakened: Narrower = (raw) => {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  return typeof r.network === "string" ? { kind: "away_confirmed", ...r } : null;
};

// The control for the OTHER direction, which needs its own mutant: an arm
// agreeing in one direction says nothing about the other. `whowas_bundle`'s
// `user` is `string | null` in the typespec, so the schema accepts a null the
// hand narrower here refuses ON PURPOSE — and `user/null` has to show up as a
// loss.
const strengthened: Narrower = (raw) => {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  return typeof r.user === "string" ? { kind: "whowas_bundle", ...r } : null;
};

// The 42 `case` labels of `narrowUserEvent`, transcribed from the switch so
// the reconciliation below has a reference OUTSIDE the schema walk.
const HAND_SWITCH_ARMS = [
  "archive_changed",
  "archive_purged",
  "auto_away_debounce_changed",
  "away_confirmed",
  "banlist_bundle",
  "bundle_hash",
  "channels_changed",
  "connection_progress",
  "connection_state_changed",
  "dcc_offer",
  "dcc_offer_resolved",
  "directory_complete",
  "directory_failed",
  "directory_progress",
  "invite_ack",
  "isupport_changed",
  "join_failed",
  "joined",
  "kicked",
  "links_bundle",
  "lusers_bundle",
  "mentions_bundle",
  "names_reply",
  "notify_list",
  "own_nick_changed",
  "peer_away",
  "presence_changed",
  "presence_error",
  "presence_snapshot",
  "query_windows_list",
  "recover_progress",
  "recover_result",
  "server_reply",
  "server_settings_changed",
  "session_identity_changed",
  "supported_umodes_changed",
  "umode_changed",
  "web_session_severed",
  "who_reply",
  "whois_bundle",
  "whowas_bundle",
  "window_invite_declined",
  "window_invited",
  "window_pending",
] as const;

// ── The divergent arms, declared ────────────────────────────────────────
//
// The census below ends in a list of arms where the hand narrower ACCEPTS
// what the generated schema rejects. That list is a MEASUREMENT and nothing
// more: it records that the two boundaries disagree, never whether the
// disagreement is MEANT. Duplication A6 puts it exactly — "with no pin, a
// deliberate widening and an accidental one look identical".
//
// vjt's ruling (2026-08-21) settles the direction — *if the behaviour is
// correct, we do not change it* — and asks for each tolerance to be written
// down where a later census cannot silently reverse it. This table is that
// record, and it is stated in the census's OWN path-and-op vocabulary so the
// two cannot describe different things.
//
// ## Why the GENERATED schema is not what moves
//
// The literal reading of "widen the schema" is to widen the Elixir typespec
// it is emitted from. That would be a lie, and a load-bearing one: the
// typespec is the server's promise about what it SENDS, while every
// tolerance below exists for a payload the CURRENT server never sends — an
// older BEAM predating the field, or a token a newer one may add. Widening
// `frame_budget_base` to `integer() | nil` would state that THIS server may
// omit it, which is false, and the next reader would believe it.
//
// The posture is already in tree, twice: `wireValidate.ts:18-31` ("a
// TOLERANCE toward a payload minted by a peer of a different vintage …
// stays hand-written at the call site, named as policy") and the #1338 X-S14
// note in `api.ts` ("the generated literal stays the SERVER's honest
// statement of what it emits today; tolerance is the client's job"). So the
// schema that widens is the one the CENSUS compares against, declaratively.
//
// ## What is machine-checked, and what is not
//
// Checked in BOTH directions: the (arm, path, op) set against the measured
// divergence. A tolerance nobody declared is `unexplained`; a declaration no
// longer describing a real divergence is `stale`. Deleting a tolerance from
// a narrower reddens the second, adding one reddens the first.
//
// Checked: `quote` must still occur VERBATIM in the file carrying the guard.
// Deleting the comment that justifies a tolerance turns this red — which is
// what keeps a citation an oracle rather than decoration.
//
// DERIVED, never restated: `covers` against `ops` yields the two sets the
// ruling asks to be REPORTED rather than closed.
//
// NOT checked: the issue numbers in `why`. Prose, for humans.

// The files carrying the hand guards. Read as TEXT — vitest runs from the
// cicchetto dir, so `src` is at cwd (the idiom `moduleRootGuard` and
// `versionSource` already use; `?raw` is stubbed to empty under vitest).
const GUARD_SOURCE = {
  userTopic: readFileSync("src/lib/userTopic.ts", "utf8"),
  wireNarrow: readFileSync("src/lib/wireNarrow.ts", "utf8"),
} as const;

type Coverage =
  // The in-tree comment states the tolerance for an ABSENT key, and says
  // nothing about a key that is PRESENT carrying an unusable value — which
  // the same guard also absorbs. The gap is the point of recording it.
  | "absent"
  // …and for a present-but-unusable value too: an explicit "malformed",
  // "garbled", "unmodelled", "non-number", or a positive-test policy that by
  // construction admits every other value.
  | "any-unusable-value"
  // No in-tree statement of this tolerance was located at all.
  | "none";

type Declared = {
  readonly ops: readonly Op[];
  readonly covers: Coverage;
  readonly file: keyof typeof GUARD_SOURCE;
  /** An exact, single-line substring of the comment that states the tolerance. */
  readonly quote: string;
  readonly why: string;
};

// Twelve LUSERS counts behind ONE guard (`intOrNull`). Stating the reason
// once is not compression for its own sake: twelve copies of a sentence are
// twelve things that have to stay true.
const LUSERS_COUNTS = [
  "total_users",
  "invisible",
  "servers",
  "operators",
  "unknown_connections",
  "channels_formed",
  "local_clients",
  "local_servers",
  "current_local",
  "max_local",
  "current_global",
  "max_global",
] as const;

const LUSERS_COUNT_TOLERANCE: Declared = {
  ops: ["drop", "wrong-type"],
  covers: "any-unusable-value",
  file: "userTopic",
  quote: "Per-field null-coercion of a non-number is",
  why: "P-0d + S44 — a display-only card in the $server window. A truncated response omits a count and a garbled one mistypes it; either renders as a dash rather than blowing away the eleven good counts beside it.",
};

const DECLARED_TOLERANCES = {
  isupport_changed: {
    // #1393d — `list_modes_queryable`, `prefix_order` and `chantypes` (and
    // the three `.0` element rows behind the same `??`) were declared here
    // and are GONE, because the guards they described are gone. They were
    // the six `covers: "absent"` rows the ruling reached: each comment
    // justified a fallback for a missing key while the code applied it to a
    // present-but-unusable one too. Removing a tolerance without removing
    // its declaration turns the reconciliation below `stale`, which is the
    // half of the two-sided check that exists for exactly this edit.
    //
    // What is left is the set that STAYS tolerant on purpose: every one of
    // these degrades to a state the server can genuinely be in ("nothing
    // advertised"), rather than to a value nobody sent.
    casemapping: {
      ops: ["drop", "null", "wrong-type", "swap"],
      covers: "any-unusable-value",
      file: "wireNarrow",
      quote: "is a closed set server-side; an unmodelled value",
      why: "#1255 — degrading to `ascii` is the same call `Grappa.Session.ISupport` makes, so client and server cannot disagree about which fold a network got. Too lax beats merging identities the ircd keeps apart.",
    },
    maxlist: {
      ops: ["drop", "null", "wrong-type"],
      covers: "any-unusable-value",
      file: "wireNarrow",
      quote: "so a malformed value degrades to them",
      why: "#1255 — no advertised cap is an honest absent state; a number nobody advertised is not.",
    },
    "maxlist.key": {
      ops: ["null", "wrong-type"],
      covers: "any-unusable-value",
      file: "wireNarrow",
      quote: "A single bad entry voids",
      why: "#1255 — one bad entry voids the whole map rather than half-capping the modal from a payload we cannot trust.",
    },
    nicklen: {
      ops: ["drop", "wrong-type"],
      covers: "any-unusable-value",
      file: "wireNarrow",
      quote: "so a malformed value degrades to them",
      why: "#1255 — `narrowPositiveInt`: zero and negatives are not caps, they are values that would reject everything, so they read as unadvertised.",
    },
    channellen: {
      ops: ["drop", "wrong-type"],
      covers: "any-unusable-value",
      file: "wireNarrow",
      quote: "so a malformed value degrades to them",
      why: "#1255 — `narrowPositiveInt`, as `nicklen`.",
    },
    topiclen: {
      ops: ["drop", "wrong-type"],
      covers: "any-unusable-value",
      file: "wireNarrow",
      quote: "so a malformed value degrades to them",
      why: "#1255 — `narrowPositiveInt`, as `nicklen`.",
    },
    frame_budget_base: {
      ops: ["drop", "null", "wrong-type"],
      covers: "any-unusable-value",
      file: "wireNarrow",
      quote: "absent or malformed means ABSENT",
      why: "#1108, recorded intentional by #1406 and named by vjt's ruling. The /mode toggles this payload seeds must survive a server predating the budget, and cic's own rule for an unknown budget is to show no warning at all.",
    },
  },
  lusers_bundle: Object.fromEntries(
    LUSERS_COUNTS.map((field) => [field, LUSERS_COUNT_TOLERANCE]),
  ) as Record<(typeof LUSERS_COUNTS)[number], Declared>,
  whois_bundle: {
    source: {
      ops: ["drop", "null", "wrong-type", "swap"],
      covers: "any-unusable-value",
      file: "userTopic",
      quote: "Tolerant, NOT a drop condition (old servers omit it)",
      why: '#606 — request origin, add-only. The guard is a POSITIVE test (`r.source === "rail" ? "rail" : "user"`), so by construction every other value normalises to the safe /whois card path; only an explicit "rail" opts into rail-only routing.',
    },
    avatar_url: {
      ops: ["drop"],
      covers: "absent",
      file: "userTopic",
      quote: "additive: absent (pre-M3b server) tolerates same as null",
      why: "M3b — the peer-avatar URL landed after the bundle did, so a server predating it omits the key entirely and a bundle otherwise perfect must not be thrown away over a field that means `no avatar` when missing. Only ABSENCE is tolerated: a PRESENT non-string still drops the bundle, same strictness as every sibling nullable here.",
    },
    // #1393d — `extra_lines` was the single `covers: "none"` row in this
    // whole table: the `!== undefined` guard shipped with the field
    // (05551231) and no in-tree sentence ever said why an absent key should
    // read as an empty bundle. The previous slice REPORTED it rather than
    // closing it, because the ruling of the day ("if the behaviour is
    // correct, we do not change it") could not settle a tolerance whose
    // correctness nobody had ever stated. vjt's strict ruling settles it:
    // the key is always on the wire, so its absence is not a vintage, and
    // `null` — which the server really does emit — is still accepted.
  },
  // #1393d — `banlist_bundle` is gone from this table and off the hand switch.
  // Its one declared tolerance was `mode/drop`, the narrowest row the census
  // ever carried, and the earlier slice of this same issue (5703d301) had
  // already closed the PRESENT-and-mangled half. vjt's strict ruling closes
  // the absent half: `mode` is a plain required string, so a grappa running
  // this code cannot omit it, and the only peer that could — one predating
  // #1251 — is what the protocol floor reports now. With the coercion gone the
  // arm had nothing the schema does not say, so it calls `validate`.
  //
  // #1393d — `links_bundle` left with it, and its row is the one worth
  // remembering how we got wrong. `mask/drop` survived a whole slice on the
  // reading that `String.t() | nil` makes the field OPTIONAL. It does not.
  // `| nil` is the VALUE axis — the null is real and carries meaning (`null`
  // ⇒ the bare full-mesh request, non-null ⇒ "no server matches <mask>") and
  // is still accepted. Whether the KEY may be MISSING is a different axis,
  // and the generated schema answers it: `mask` is required, exactly like
  // `banlist_bundle.mode`. Two axes, one `| nil`, and conflating them is what
  // kept the tolerance alive. Both arms now call `validate`, which keeps the
  // value axis and closes the key axis in the same call.
  // #1393d — `window_invited` and `connection_state_changed` had exactly one
  // declared tolerance each (`inviter`, `network.recoverable`), and losing it
  // left each arm at full parity with its schema on BOTH censuses. So both
  // arms are gone from this table AND gone from `userTopic.ts` as hand
  // narrowers: they call `validate` now. An arm with no entry here is an arm
  // the measurement finds nothing to explain about.
  server_settings_changed: {
    "upload.video_max_duration_seconds": {
      ops: ["drop", "null", "wrong-type"],
      covers: "any-unusable-value",
      file: "userTopic",
      quote: "Absent / malformed →",
      why: "#201 — lenient unlike the byte caps beside it: hard-narrowing would drop the WHOLE settings push against a pre-#201 server and strand those caps too.",
    },
    http_host_aliases: {
      ops: ["drop", "null", "wrong-type"],
      covers: "any-unusable-value",
      file: "userTopic",
      quote: "Lenient: a malformed /",
      why: "#324 — degrades to [] (page origin only) rather than dropping the settings push.",
    },
    "http_host_aliases.0": {
      ops: ["null", "wrong-type"],
      covers: "any-unusable-value",
      file: "userTopic",
      quote: "Filter to strings so a proxy-mangled element",
      why: "#324 — a mangled element is filtered out so it cannot poison mediaLink's host-membership check.",
    },
  },
  bundle_hash: {
    version: {
      ops: ["null", "wrong-type"],
      covers: "any-unusable-value",
      file: "userTopic",
      quote: "Normalise absent / malformed → null",
      why: "#292 (cross-surface S2) — the consumer always sees `string | null`. Absence is not in `ops` because the schema already declares the key optional. Registered type-side as `DiscriminatorOnlyArm` (wireTypesAssert.ts): a conversion, not a superset, which is why it is not in `DeliberatelyWidened`.",
    },
  },
  recover_progress: {
    reason: {
      ops: ["swap"],
      covers: "any-unusable-value",
      file: "userTopic",
      quote: "over four tokens; this boundary takes any string, deliberately",
      why: "#581 + #447 — the typespec closes `reason` over four tokens; a BEAM that adds a fifth must not make an older cic drop the ping. Only the value-swap op can see this class at all.",
    },
  },
  recover_result: {
    reason: {
      ops: ["swap"],
      covers: "any-unusable-value",
      file: "userTopic",
      quote: "additive server reason token can never drop a terminal result event",
      why: "#581 + #447 — as `recover_progress`, and here the stakes are a TERMINAL event rather than a presentational ping.",
    },
  },
  web_session_severed: {
    code: {
      ops: ["swap"],
      covers: "any-unusable-value",
      file: "userTopic",
      quote: "from the closed literal to any string",
      why: "#630 + #1338 X-S14 — the drop-to-login action does not depend on the code; it selects copy. Dropping a terminal event over an unrecognised token would strand the client on a dead shell holding a revoked bearer.",
    },
  },
} satisfies Record<string, Record<string, Declared>>;

type Assert<T extends true> = T;

// Two registries, one boundary: `DeliberatelyWidened` exempts a field in the
// TS TYPE, this table declares the RUNTIME tolerance that must go with it. A
// type that says cic accepts a wider `code` while the narrower still rejects
// it is a boundary that drops at ingress the payload it advertises. So the
// runtime table has to SUBSUME the type-level one, arm AND field — the check
// that keeps them from being two hand-kept lists.
type TypeWideningIsDeclaredAtRuntime = Assert<
  {
    [K in keyof DeliberatelyWidened]: K extends keyof typeof DECLARED_TOLERANCES
      ? DeliberatelyWidened[K] extends keyof (typeof DECLARED_TOLERANCES)[K]
        ? true
        : false
      : false;
  }[keyof DeliberatelyWidened] extends true
    ? true
    : false
>;

describe("#1393 — user-topic boundary census", () => {
  it("detects a weakened boundary (control for the matrix itself)", () => {
    const node = candidatesFor("away_confirmed")[0].node;
    const valid = sample(node) as Record<string, unknown>;
    const generated: Narrower = (raw) => validate(node, raw);
    const holes = Object.keys(valid)
      .filter((f) => f !== "kind")
      .filter(
        (f) =>
          verdict(weakened, { ...valid, [f]: null }) === "accept" &&
          verdict(generated, { ...valid, [f]: null }) === "reject",
      );
    expect(holes).toMatchInlineSnapshot(`
      [
        "state",
      ]
    `);
  });

  it("detects a strengthened boundary (control for the second direction)", () => {
    const node = candidatesFor("whowas_bundle")[0].node;
    const valid = sample(node) as Record<string, unknown>;
    const generated: Narrower = (raw) => validate(node, raw);
    const losses = Object.keys(valid)
      .filter((f) => f !== "kind")
      .filter(
        (f) =>
          verdict(generated, { ...valid, [f]: null }) === "accept" &&
          verdict(strengthened, { ...valid, [f]: null }) === "reject",
      );
    expect(losses).toMatchInlineSnapshot(`
      [
        "user",
      ]
    `);
  });

  // Reconciliation. The census walks SCHEMAS (indexed by kind literal), while
  // the thing under test is the hand `switch` in `userTopic.ts`. Those two
  // sets are not the same by construction, so the difference is reported
  // rather than assumed away: a hand arm missing from the census is an arm
  // nobody measured, and a censused kind absent from the switch belongs to a
  // different topic and its verdict says nothing about this one.
  it("reconciles the censused set against the hand switch", () => {
    const censused = new Set(ARMS.filter(accepts));
    const handSwitch = new Set<string>(HAND_SWITCH_ARMS);
    expect({
      handArms: handSwitch.size,
      censused: censused.size,
      inSwitchNotCensused: [...handSwitch].filter((k) => !censused.has(k)),
      censusedNotInSwitch: [...censused].filter((k) => !handSwitch.has(k)),
    }).toMatchInlineSnapshot(`
      {
        "censused": 45,
        "censusedNotInSwitch": [
          "whois_avatar_ready",
        ],
        "handArms": 44,
        "inSwitchNotCensused": [],
      }
    `);
  });

  it("censuses every hand-narrowed arm against its generated schema", () => {
    const handArms = ARMS.filter(accepts);
    const reports = handArms.flatMap((k) =>
      candidatesFor(k).map(({ name, node }) => censusArm(k, name, node)),
    );
    const divergent = reports.filter(
      (r) => r.handAcceptsSchemaRejects !== "-" || r.schemaAcceptsHandRejects !== "-",
    );
    // Counted over distinct ARMS, not over reports: an ambiguous `kind`
    // literal is censused once per candidate schema, so `reports.length`
    // overcounts the boundary by however many duplicates the wire happens to
    // carry. The parity figure the verdict rests on is an arm count.
    const divergentArms = new Set(divergent.map((r) => r.arm));
    expect({
      armsWithSchema: handArms.length,
      armsCensused: reports.length,
      armsAtParity: handArms.length - divergentArms.size,
      brokenOracles: reports.filter((r) => r.schemaRejectsValid).map((r) => r.arm),
      divergent,
    }).toMatchInlineSnapshot(`
      {
        "armsAtParity": 37,
        "armsCensused": 46,
        "armsWithSchema": 45,
        "brokenOracles": [],
        "divergent": [
          {
            "arm": "web_session_severed",
            "handAcceptsSchemaRejects": "-",
            "mutations": 18,
            "schema": "S_AdminEventsWireWebSessionSeveredEvent",
            "schemaAcceptsHandRejects": "subject_id/swap, at/swap",
            "schemaRejectsValid": false,
          },
          {
            "arm": "web_session_severed",
            "handAcceptsSchemaRejects": "code/swap",
            "mutations": 4,
            "schema": "S_RateLimitWireWebSessionSeveredEvent",
            "schemaAcceptsHandRejects": "-",
            "schemaRejectsValid": false,
          },
          {
            "arm": "bundle_hash",
            "handAcceptsSchemaRejects": "version/null, version/wrong-type",
            "mutations": 8,
            "schema": "S_CicWireBundleHashPayload",
            "schemaAcceptsHandRejects": "-",
            "schemaRejectsValid": false,
          },
          {
            "arm": "server_settings_changed",
            "handAcceptsSchemaRejects": "upload.video_max_duration_seconds/drop, upload.video_max_duration_seconds/null, upload.video_max_duration_seconds/wrong-type, http_host_aliases/drop, http_host_aliases/null, http_host_aliases/wrong-type, http_host_aliases.0/null, http_host_aliases.0/wrong-type",
            "mutations": 32,
            "schema": "S_ServerSettingsWireChangedPayload",
            "schemaAcceptsHandRejects": "-",
            "schemaRejectsValid": false,
          },
          {
            "arm": "isupport_changed",
            "handAcceptsSchemaRejects": "casemapping/drop, casemapping/null, casemapping/wrong-type, casemapping/swap, maxlist/drop, maxlist/null, maxlist/wrong-type, maxlist.key/null, maxlist.key/wrong-type, nicklen/drop, nicklen/wrong-type, channellen/drop, channellen/wrong-type, topiclen/drop, topiclen/wrong-type, frame_budget_base/drop, frame_budget_base/null, frame_budget_base/wrong-type",
            "mutations": 81,
            "schema": "S_SessionWireIsupportChangedPayload",
            "schemaAcceptsHandRejects": "-",
            "schemaRejectsValid": false,
          },
          {
            "arm": "lusers_bundle",
            "handAcceptsSchemaRejects": "total_users/drop, total_users/wrong-type, invisible/drop, invisible/wrong-type, servers/drop, servers/wrong-type, operators/drop, operators/wrong-type, unknown_connections/drop, unknown_connections/wrong-type, channels_formed/drop, channels_formed/wrong-type, local_clients/drop, local_clients/wrong-type, local_servers/drop, local_servers/wrong-type, current_local/drop, current_local/wrong-type, max_local/drop, max_local/wrong-type, current_global/drop, current_global/wrong-type, max_global/drop, max_global/wrong-type",
            "mutations": 40,
            "schema": "S_SessionWireLusersBundlePayload",
            "schemaAcceptsHandRejects": "-",
            "schemaRejectsValid": false,
          },
          {
            "arm": "recover_progress",
            "handAcceptsSchemaRejects": "reason/swap",
            "mutations": 16,
            "schema": "S_SessionWireRecoverProgressPayload",
            "schemaAcceptsHandRejects": "-",
            "schemaRejectsValid": false,
          },
          {
            "arm": "recover_result",
            "handAcceptsSchemaRejects": "reason/swap",
            "mutations": 12,
            "schema": "S_SessionWireRecoverResultPayload",
            "schemaAcceptsHandRejects": "-",
            "schemaRejectsValid": false,
          },
          {
            "arm": "whois_bundle",
            "handAcceptsSchemaRejects": "source/drop, source/null, source/wrong-type, source/swap, avatar_url/drop",
            "mutations": 124,
            "schema": "S_SessionWireWhoisBundlePayload",
            "schemaAcceptsHandRejects": "-",
            "schemaRejectsValid": false,
          },
        ],
      }
    `);
  });

  // The census above measures ACCEPT/REJECT and nothing else, and that is not
  // the whole boundary. `narrowUserEvent` returns the object the dispatcher
  // then consumes, and `validate` builds its OWN object from the schema's
  // declared fields — `wireValidate.ts`'s `walkObject` drops undeclared keys
  // rather than rejecting them (additive-only, GH #447), exactly as the hand
  // arms drop them by constructing a fresh literal.
  //
  // So two narrowers can agree on every verdict in the matrix above and still
  // hand the dispatcher DIFFERENT objects, whenever the schema declares a
  // field the hand arm does not copy out. Swapping one for the other would
  // ship that difference, and the verdict census cannot see it. "At parity"
  // therefore needs both axes before an arm is safe to migrate; this measures
  // the second one.
  it("censuses the VALUE each boundary returns, not just its verdict", () => {
    const pairs = ARMS.filter(accepts).flatMap((k) =>
      candidatesFor(k).map(({ name, node }) => ({ arm: k, schema: name, node })),
    );

    // A pair is comparable only when BOTH sides produced a value. The
    // ambiguous `kind` literal leaves some arms carrying a candidate from the
    // WRONG Wire module, whose sample the hand narrower rightly rejects —
    // there is no value there to compare, and scoring it as a value
    // divergence would report the ambiguity as a defect. Skipped pairs are
    // COUNTED, not dropped, so the arithmetic stays closed.
    const comparable = pairs.filter(
      ({ node }) =>
        verdict(hand, sample(node)) === "accept" &&
        verdict((raw) => validate(node, raw), sample(node)) === "accept",
    );

    const divergent = comparable
      .map(({ arm, schema, node }) => {
        const valid = sample(node);
        const byHand = hand(valid);
        const bySchema = validate(node, valid);
        const handKeys = keysOf(byHand);
        const schemaKeys = keysOf(bySchema);
        return {
          arm,
          schema,
          onlyHand: handKeys.filter((f) => !schemaKeys.includes(f)),
          onlySchema: schemaKeys.filter((f) => !handKeys.includes(f)),
          sameValue: JSON.stringify(canon(byHand)) === JSON.stringify(canon(bySchema)),
        };
      })
      .filter((r) => !r.sameValue);

    expect({
      pairs: pairs.length,
      comparablePairs: comparable.length,
      skippedOneSideRejected: pairs.length - comparable.length,
      armsAtValueParity:
        new Set(comparable.map((p) => p.arm)).size - new Set(divergent.map((r) => r.arm)).size,
      divergent,
    }).toMatchInlineSnapshot(`
      {
        "armsAtValueParity": 45,
        "comparablePairs": 45,
        "divergent": [],
        "pairs": 46,
        "skippedOneSideRejected": 1,
      }
    `);
  });

  // Slice 1 of the migration this file measured.
  //
  // The two censuses above compare the hand narrower against the schema. The
  // moment an arm's `case` calls `validate` with its own generated schema,
  // both of them compare that schema against ITSELF for that arm and report
  // parity BY CONSTRUCTION — still printing 34 and 42, still green, and
  // measuring nothing. A migration that quietly converts its own oracle into
  // a tautology is a gate that lies, so the property the migration has to
  // preserve gets an oracle that never consults a schema to JUDGE.
  //
  // A schema is still the only available source of a valid payload, so it
  // generates the inputs; the recorded verdict and returned value are the
  // narrower's alone. Taken BEFORE the migration this is a record of what the
  // boundary did, and an unchanged snapshot afterwards is the evidence that
  // it still does it. A schema edit moves the inputs and therefore the
  // snapshot — that is a signal, not noise.
  //
  // Extend the list with each slice. An arm left off it is migrated with no
  // oracle at all.
  const MIGRATED_ARMS = [
    "archive_changed",
    "archive_purged",
    "auto_away_debounce_changed",
    "away_confirmed",
    // #1393d, second slice — `banlist_bundle` lost its last tolerance and
    // moved onto `validate` with it.
    "banlist_bundle",
    "channels_changed",
    "connection_progress",
    // #1393d — the four arms this slice touched. Two moved onto `validate`
    // (`window_invited`, `connection_state_changed`); two stay hand-written
    // because a DELIBERATE tolerance blocks a whole-arm swap and only the
    // strict fields moved (`isupport_changed` keeps the six "nothing
    // advertised" degrades, `whois_bundle` keeps `source`, #606). Pinned the
    // same way either way: the pin judges the narrower's own verdicts, never
    // a schema, so it stays an oracle for the hand arms and does not become
    // a tautology for the migrated ones.
    "connection_state_changed",
    "directory_complete",
    "directory_failed",
    "directory_progress",
    "invite_ack",
    "isupport_changed",
    "join_failed",
    "joined",
    "kicked",
    // #1393d, third slice — `links_bundle` lost the same key-axis tolerance
    // `banlist_bundle` did, once `| nil` stopped being read as "optional".
    "links_bundle",
    "mentions_bundle",
    "names_reply",
    "notify_list",
    "own_nick_changed",
    "peer_away",
    "presence_changed",
    "presence_error",
    "presence_snapshot",
    "query_windows_list",
    "recover_progress",
    "recover_result",
    "server_reply",
    "session_identity_changed",
    "supported_umodes_changed",
    "umode_changed",
    "web_session_severed",
    "who_reply",
    "whois_bundle",
    "whowas_bundle",
    "window_invite_declined",
    "window_invited",
    "window_pending",
  ] as const;

  it("pins what the migrated arms accept and return, judged without a schema", () => {
    const pinned = MIGRATED_ARMS.map((arm) => {
      // An ambiguous `kind` literal must not be resolved by taking `[0]` —
      // that is a coin toss between two Wire modules, and for
      // `web_session_severed` the loser is the admin one, whose shape this
      // topic never carries. Resolve it by MEASUREMENT rather than by a
      // hard-coded name: the right candidate is the one whose sample the hand
      // narrower accepts, and exactly one must, or the disambiguation is not
      // a fact and the pin refuses to guess.
      const candidates = candidatesFor(arm).filter(
        ({ node }) => verdict(hand, sample(node)) === "accept",
      );
      // `only === undefined` is not defensive noise: a length check does not
      // narrow an index under `noUncheckedIndexedAccess`, and the two
      // conditions are the same fact stated where the compiler can see it.
      const [only] = candidates;
      if (candidates.length !== 1 || only === undefined) {
        throw new Error(
          `"${arm}": ${candidates.length} candidates produce a sample the hand narrower accepts — expected exactly 1`,
        );
      }
      const node = only.node;
      const valid = sample(node) as Record<string, unknown>;

      const matrix: Record<string, string> = {};
      for (const { label, payload } of mutations(valid)) {
        matrix[label] = verdict(hand, payload);
      }
      return { arm, returns: canon(hand(valid)), matrix };
    });

    expect(pinned).toMatchInlineSnapshot(`
      [
        {
          "arm": "archive_changed",
          "matrix": {
            "network_slug/drop": "reject",
            "network_slug/null": "reject",
            "network_slug/swap": "accept",
            "network_slug/wrong-type": "reject",
          },
          "returns": {
            "kind": "archive_changed",
            "network_slug": "sample",
          },
        },
        {
          "arm": "archive_purged",
          "matrix": {
            "network_slug/drop": "reject",
            "network_slug/null": "reject",
            "network_slug/swap": "accept",
            "network_slug/wrong-type": "reject",
            "target/drop": "reject",
            "target/null": "reject",
            "target/swap": "accept",
            "target/wrong-type": "reject",
          },
          "returns": {
            "kind": "archive_purged",
            "network_slug": "sample",
            "target": "sample",
          },
        },
        {
          "arm": "auto_away_debounce_changed",
          "matrix": {
            "auto_away_debounce_seconds/drop": "reject",
            "auto_away_debounce_seconds/null": "accept",
            "auto_away_debounce_seconds/wrong-type": "reject",
          },
          "returns": {
            "auto_away_debounce_seconds": 1,
            "kind": "auto_away_debounce_changed",
          },
        },
        {
          "arm": "away_confirmed",
          "matrix": {
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
            "state/drop": "reject",
            "state/null": "reject",
            "state/swap": "reject",
            "state/wrong-type": "reject",
          },
          "returns": {
            "kind": "away_confirmed",
            "network": "sample",
            "state": "present",
          },
        },
        {
          "arm": "banlist_bundle",
          "matrix": {
            "channel/drop": "reject",
            "channel/null": "reject",
            "channel/swap": "accept",
            "channel/wrong-type": "reject",
            "entries.0.mask/drop": "reject",
            "entries.0.mask/null": "reject",
            "entries.0.mask/swap": "accept",
            "entries.0.mask/wrong-type": "reject",
            "entries.0.set_ts/drop": "reject",
            "entries.0.set_ts/null": "accept",
            "entries.0.set_ts/swap": "accept",
            "entries.0.set_ts/wrong-type": "reject",
            "entries.0.setter/drop": "reject",
            "entries.0.setter/null": "accept",
            "entries.0.setter/swap": "accept",
            "entries.0.setter/wrong-type": "reject",
            "entries.0/drop": "accept",
            "entries.0/null": "reject",
            "entries.0/wrong-type": "reject",
            "entries/drop": "reject",
            "entries/null": "reject",
            "entries/wrong-type": "reject",
            "mode/drop": "reject",
            "mode/null": "reject",
            "mode/swap": "accept",
            "mode/wrong-type": "reject",
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
          },
          "returns": {
            "channel": "sample",
            "entries": [
              {
                "mask": "sample",
                "set_ts": "sample",
                "setter": "sample",
              },
            ],
            "kind": "banlist_bundle",
            "mode": "sample",
            "network": "sample",
          },
        },
        {
          "arm": "channels_changed",
          "matrix": {},
          "returns": {
            "kind": "channels_changed",
          },
        },
        {
          "arm": "connection_progress",
          "matrix": {
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
            "state/drop": "reject",
            "state/null": "reject",
            "state/swap": "reject",
            "state/wrong-type": "reject",
          },
          "returns": {
            "kind": "connection_progress",
            "network": "sample",
            "state": "connecting",
          },
        },
        {
          "arm": "connection_state_changed",
          "matrix": {
            "at/drop": "reject",
            "at/null": "accept",
            "at/swap": "accept",
            "at/wrong-type": "reject",
            "from/drop": "reject",
            "from/null": "reject",
            "from/swap": "reject",
            "from/wrong-type": "reject",
            "network.connection_state/drop": "reject",
            "network.connection_state/null": "reject",
            "network.connection_state/swap": "reject",
            "network.connection_state/wrong-type": "reject",
            "network.connection_state_changed_at/drop": "reject",
            "network.connection_state_changed_at/null": "accept",
            "network.connection_state_changed_at/swap": "accept",
            "network.connection_state_changed_at/wrong-type": "reject",
            "network.connection_state_reason/drop": "reject",
            "network.connection_state_reason/null": "accept",
            "network.connection_state_reason/swap": "accept",
            "network.connection_state_reason/wrong-type": "reject",
            "network.nick/drop": "reject",
            "network.nick/null": "reject",
            "network.nick/swap": "accept",
            "network.nick/wrong-type": "reject",
            "network.recoverable/drop": "reject",
            "network.recoverable/null": "reject",
            "network.recoverable/wrong-type": "reject",
            "network.slug/drop": "reject",
            "network.slug/null": "reject",
            "network.slug/swap": "accept",
            "network.slug/wrong-type": "reject",
            "network/drop": "reject",
            "network/null": "reject",
            "network/wrong-type": "reject",
            "network_id/drop": "reject",
            "network_id/null": "reject",
            "network_id/wrong-type": "reject",
            "network_slug/drop": "reject",
            "network_slug/null": "reject",
            "network_slug/swap": "accept",
            "network_slug/wrong-type": "reject",
            "reason/drop": "reject",
            "reason/null": "accept",
            "reason/swap": "accept",
            "reason/wrong-type": "reject",
            "to/drop": "reject",
            "to/null": "reject",
            "to/swap": "reject",
            "to/wrong-type": "reject",
            "user_id/drop": "reject",
            "user_id/null": "accept",
            "user_id/swap": "accept",
            "user_id/wrong-type": "reject",
          },
          "returns": {
            "at": "sample",
            "from": "connected",
            "kind": "connection_state_changed",
            "network": {
              "connection_state": "connected",
              "connection_state_changed_at": "sample",
              "connection_state_reason": "sample",
              "nick": "sample",
              "recoverable": true,
              "slug": "sample",
            },
            "network_id": 1,
            "network_slug": "sample",
            "reason": "sample",
            "to": "connected",
            "user_id": "sample",
          },
        },
        {
          "arm": "directory_complete",
          "matrix": {
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
            "total/drop": "reject",
            "total/null": "reject",
            "total/wrong-type": "reject",
          },
          "returns": {
            "kind": "directory_complete",
            "network": "sample",
            "total": 1,
          },
        },
        {
          "arm": "directory_failed",
          "matrix": {
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
            "reason/drop": "reject",
            "reason/null": "reject",
            "reason/swap": "accept",
            "reason/wrong-type": "reject",
          },
          "returns": {
            "kind": "directory_failed",
            "network": "sample",
            "reason": "sample",
          },
        },
        {
          "arm": "directory_progress",
          "matrix": {
            "count/drop": "reject",
            "count/null": "reject",
            "count/wrong-type": "reject",
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
          },
          "returns": {
            "count": 1,
            "kind": "directory_progress",
            "network": "sample",
          },
        },
        {
          "arm": "invite_ack",
          "matrix": {
            "channel/drop": "reject",
            "channel/null": "reject",
            "channel/swap": "accept",
            "channel/wrong-type": "reject",
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
            "peer/drop": "reject",
            "peer/null": "reject",
            "peer/swap": "accept",
            "peer/wrong-type": "reject",
          },
          "returns": {
            "channel": "sample",
            "kind": "invite_ack",
            "network": "sample",
            "peer": "sample",
          },
        },
        {
          "arm": "isupport_changed",
          "matrix": {
            "casemapping/drop": "accept",
            "casemapping/null": "accept",
            "casemapping/swap": "accept",
            "casemapping/wrong-type": "accept",
            "chanmodes_a.0/drop": "accept",
            "chanmodes_a.0/null": "reject",
            "chanmodes_a.0/swap": "accept",
            "chanmodes_a.0/wrong-type": "reject",
            "chanmodes_a/drop": "reject",
            "chanmodes_a/null": "reject",
            "chanmodes_a/wrong-type": "reject",
            "chanmodes_b.0/drop": "accept",
            "chanmodes_b.0/null": "reject",
            "chanmodes_b.0/swap": "accept",
            "chanmodes_b.0/wrong-type": "reject",
            "chanmodes_b/drop": "reject",
            "chanmodes_b/null": "reject",
            "chanmodes_b/wrong-type": "reject",
            "chanmodes_c.0/drop": "accept",
            "chanmodes_c.0/null": "reject",
            "chanmodes_c.0/swap": "accept",
            "chanmodes_c.0/wrong-type": "reject",
            "chanmodes_c/drop": "reject",
            "chanmodes_c/null": "reject",
            "chanmodes_c/wrong-type": "reject",
            "chanmodes_d.0/drop": "accept",
            "chanmodes_d.0/null": "reject",
            "chanmodes_d.0/swap": "accept",
            "chanmodes_d.0/wrong-type": "reject",
            "chanmodes_d/drop": "reject",
            "chanmodes_d/null": "reject",
            "chanmodes_d/wrong-type": "reject",
            "channellen/drop": "accept",
            "channellen/null": "accept",
            "channellen/wrong-type": "accept",
            "chantypes.0/drop": "accept",
            "chantypes.0/null": "reject",
            "chantypes.0/swap": "accept",
            "chantypes.0/wrong-type": "reject",
            "chantypes/drop": "reject",
            "chantypes/null": "reject",
            "chantypes/wrong-type": "reject",
            "frame_budget_base/drop": "accept",
            "frame_budget_base/null": "accept",
            "frame_budget_base/wrong-type": "accept",
            "list_modes_queryable.0/drop": "accept",
            "list_modes_queryable.0/null": "reject",
            "list_modes_queryable.0/swap": "accept",
            "list_modes_queryable.0/wrong-type": "reject",
            "list_modes_queryable/drop": "reject",
            "list_modes_queryable/null": "reject",
            "list_modes_queryable/wrong-type": "reject",
            "maxlist.key/drop": "accept",
            "maxlist.key/null": "accept",
            "maxlist.key/wrong-type": "accept",
            "maxlist/drop": "accept",
            "maxlist/null": "accept",
            "maxlist/wrong-type": "accept",
            "network_id/drop": "reject",
            "network_id/null": "reject",
            "network_id/wrong-type": "reject",
            "nicklen/drop": "accept",
            "nicklen/null": "accept",
            "nicklen/wrong-type": "accept",
            "prefix.key/drop": "accept",
            "prefix.key/null": "reject",
            "prefix.key/swap": "accept",
            "prefix.key/wrong-type": "reject",
            "prefix/drop": "reject",
            "prefix/null": "reject",
            "prefix/wrong-type": "reject",
            "prefix_order.0/drop": "accept",
            "prefix_order.0/null": "reject",
            "prefix_order.0/swap": "accept",
            "prefix_order.0/wrong-type": "reject",
            "prefix_order/drop": "reject",
            "prefix_order/null": "reject",
            "prefix_order/wrong-type": "reject",
            "topiclen/drop": "accept",
            "topiclen/null": "accept",
            "topiclen/wrong-type": "accept",
          },
          "returns": {
            "casemapping": "ascii",
            "chanmodes_a": [
              "sample",
            ],
            "chanmodes_b": [
              "sample",
            ],
            "chanmodes_c": [
              "sample",
            ],
            "chanmodes_d": [
              "sample",
            ],
            "channellen": 1,
            "chantypes": [
              "sample",
            ],
            "frame_budget_base": 1,
            "kind": "isupport_changed",
            "list_modes_queryable": [
              "sample",
            ],
            "maxlist": {
              "key": 1,
            },
            "network_id": 1,
            "nicklen": 1,
            "prefix": {
              "key": "sample",
            },
            "prefix_order": [
              "sample",
            ],
            "topiclen": 1,
          },
        },
        {
          "arm": "join_failed",
          "matrix": {
            "channel/drop": "reject",
            "channel/null": "reject",
            "channel/swap": "accept",
            "channel/wrong-type": "reject",
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
            "numeric/drop": "reject",
            "numeric/null": "accept",
            "numeric/wrong-type": "reject",
            "reason/drop": "reject",
            "reason/null": "accept",
            "reason/swap": "accept",
            "reason/wrong-type": "reject",
            "state/drop": "reject",
            "state/null": "reject",
            "state/swap": "reject",
            "state/wrong-type": "reject",
          },
          "returns": {
            "channel": "sample",
            "kind": "join_failed",
            "network": "sample",
            "numeric": 1,
            "reason": "sample",
            "state": "failed",
          },
        },
        {
          "arm": "joined",
          "matrix": {
            "channel/drop": "reject",
            "channel/null": "reject",
            "channel/swap": "accept",
            "channel/wrong-type": "reject",
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
            "state/drop": "reject",
            "state/null": "reject",
            "state/swap": "reject",
            "state/wrong-type": "reject",
          },
          "returns": {
            "channel": "sample",
            "kind": "joined",
            "network": "sample",
            "state": "joined",
          },
        },
        {
          "arm": "kicked",
          "matrix": {
            "by/drop": "reject",
            "by/null": "accept",
            "by/swap": "accept",
            "by/wrong-type": "reject",
            "channel/drop": "reject",
            "channel/null": "reject",
            "channel/swap": "accept",
            "channel/wrong-type": "reject",
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
            "reason/drop": "reject",
            "reason/null": "accept",
            "reason/swap": "accept",
            "reason/wrong-type": "reject",
            "state/drop": "reject",
            "state/null": "reject",
            "state/swap": "reject",
            "state/wrong-type": "reject",
          },
          "returns": {
            "by": "sample",
            "channel": "sample",
            "kind": "kicked",
            "network": "sample",
            "reason": "sample",
            "state": "kicked",
          },
        },
        {
          "arm": "links_bundle",
          "matrix": {
            "entries.0.description/drop": "reject",
            "entries.0.description/null": "accept",
            "entries.0.description/swap": "accept",
            "entries.0.description/wrong-type": "reject",
            "entries.0.hopcount/drop": "reject",
            "entries.0.hopcount/null": "accept",
            "entries.0.hopcount/wrong-type": "reject",
            "entries.0.linked_to/drop": "reject",
            "entries.0.linked_to/null": "accept",
            "entries.0.linked_to/swap": "accept",
            "entries.0.linked_to/wrong-type": "reject",
            "entries.0.server/drop": "reject",
            "entries.0.server/null": "reject",
            "entries.0.server/swap": "accept",
            "entries.0.server/wrong-type": "reject",
            "entries.0/drop": "accept",
            "entries.0/null": "reject",
            "entries.0/wrong-type": "reject",
            "entries/drop": "reject",
            "entries/null": "reject",
            "entries/wrong-type": "reject",
            "mask/drop": "reject",
            "mask/null": "accept",
            "mask/swap": "accept",
            "mask/wrong-type": "reject",
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
          },
          "returns": {
            "entries": [
              {
                "description": "sample",
                "hopcount": 1,
                "linked_to": "sample",
                "server": "sample",
              },
            ],
            "kind": "links_bundle",
            "mask": "sample",
            "network": "sample",
          },
        },
        {
          "arm": "mentions_bundle",
          "matrix": {
            "away_ended_at/drop": "reject",
            "away_ended_at/null": "reject",
            "away_ended_at/swap": "accept",
            "away_ended_at/wrong-type": "reject",
            "away_reason/drop": "reject",
            "away_reason/null": "accept",
            "away_reason/swap": "accept",
            "away_reason/wrong-type": "reject",
            "away_started_at/drop": "reject",
            "away_started_at/null": "reject",
            "away_started_at/swap": "accept",
            "away_started_at/wrong-type": "reject",
            "messages.0.body/drop": "reject",
            "messages.0.body/null": "accept",
            "messages.0.body/swap": "accept",
            "messages.0.body/wrong-type": "reject",
            "messages.0.channel/drop": "reject",
            "messages.0.channel/null": "reject",
            "messages.0.channel/swap": "accept",
            "messages.0.channel/wrong-type": "reject",
            "messages.0.kind/drop": "reject",
            "messages.0.kind/null": "reject",
            "messages.0.kind/swap": "reject",
            "messages.0.kind/wrong-type": "reject",
            "messages.0.sender/drop": "reject",
            "messages.0.sender/null": "reject",
            "messages.0.sender/swap": "accept",
            "messages.0.sender/wrong-type": "reject",
            "messages.0.server_time/drop": "reject",
            "messages.0.server_time/null": "reject",
            "messages.0.server_time/wrong-type": "reject",
            "messages.0/drop": "accept",
            "messages.0/null": "reject",
            "messages.0/wrong-type": "reject",
            "messages/drop": "reject",
            "messages/null": "reject",
            "messages/wrong-type": "reject",
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
          },
          "returns": {
            "away_ended_at": "sample",
            "away_reason": "sample",
            "away_started_at": "sample",
            "kind": "mentions_bundle",
            "messages": [
              {
                "body": "sample",
                "channel": "sample",
                "kind": "privmsg",
                "sender": "sample",
                "server_time": 1,
              },
            ],
            "network": "sample",
          },
        },
        {
          "arm": "names_reply",
          "matrix": {
            "channel/drop": "reject",
            "channel/null": "reject",
            "channel/swap": "accept",
            "channel/wrong-type": "reject",
            "members.0.gender/drop": "accept",
            "members.0.gender/null": "accept",
            "members.0.gender/swap": "reject",
            "members.0.gender/wrong-type": "reject",
            "members.0.modes.0/drop": "accept",
            "members.0.modes.0/null": "reject",
            "members.0.modes.0/swap": "accept",
            "members.0.modes.0/wrong-type": "reject",
            "members.0.modes/drop": "reject",
            "members.0.modes/null": "reject",
            "members.0.modes/wrong-type": "reject",
            "members.0.nick/drop": "reject",
            "members.0.nick/null": "reject",
            "members.0.nick/swap": "accept",
            "members.0.nick/wrong-type": "reject",
            "members.0/drop": "accept",
            "members.0/null": "reject",
            "members.0/wrong-type": "reject",
            "members/drop": "reject",
            "members/null": "reject",
            "members/wrong-type": "reject",
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
          },
          "returns": {
            "channel": "sample",
            "kind": "names_reply",
            "members": [
              {
                "gender": "male",
                "modes": [
                  "sample",
                ],
                "nick": "sample",
              },
            ],
            "network": "sample",
          },
        },
        {
          "arm": "notify_list",
          "matrix": {
            "networks.key.0.added_at/drop": "reject",
            "networks.key.0.added_at/null": "reject",
            "networks.key.0.added_at/swap": "accept",
            "networks.key.0.added_at/wrong-type": "reject",
            "networks.key.0.network_id/drop": "reject",
            "networks.key.0.network_id/null": "reject",
            "networks.key.0.network_id/wrong-type": "reject",
            "networks.key.0.nick/drop": "reject",
            "networks.key.0.nick/null": "reject",
            "networks.key.0.nick/swap": "accept",
            "networks.key.0.nick/wrong-type": "reject",
            "networks.key.0/drop": "accept",
            "networks.key.0/null": "reject",
            "networks.key.0/wrong-type": "reject",
            "networks.key/drop": "accept",
            "networks.key/null": "reject",
            "networks.key/wrong-type": "reject",
            "networks/drop": "reject",
            "networks/null": "reject",
            "networks/wrong-type": "reject",
          },
          "returns": {
            "kind": "notify_list",
            "networks": {
              "key": [
                {
                  "added_at": "sample",
                  "network_id": 1,
                  "nick": "sample",
                },
              ],
            },
          },
        },
        {
          "arm": "own_nick_changed",
          "matrix": {
            "network_id/drop": "reject",
            "network_id/null": "reject",
            "network_id/wrong-type": "reject",
            "nick/drop": "reject",
            "nick/null": "reject",
            "nick/swap": "accept",
            "nick/wrong-type": "reject",
          },
          "returns": {
            "kind": "own_nick_changed",
            "network_id": 1,
            "nick": "sample",
          },
        },
        {
          "arm": "peer_away",
          "matrix": {
            "message/drop": "reject",
            "message/null": "reject",
            "message/swap": "accept",
            "message/wrong-type": "reject",
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
            "peer/drop": "reject",
            "peer/null": "reject",
            "peer/swap": "accept",
            "peer/wrong-type": "reject",
          },
          "returns": {
            "kind": "peer_away",
            "message": "sample",
            "network": "sample",
            "peer": "sample",
          },
        },
        {
          "arm": "presence_changed",
          "matrix": {
            "initial/drop": "reject",
            "initial/null": "reject",
            "initial/wrong-type": "reject",
            "network_id/drop": "reject",
            "network_id/null": "reject",
            "network_id/wrong-type": "reject",
            "nick/drop": "reject",
            "nick/null": "reject",
            "nick/swap": "accept",
            "nick/wrong-type": "reject",
            "presence/drop": "reject",
            "presence/null": "reject",
            "presence/swap": "reject",
            "presence/wrong-type": "reject",
            "source/drop": "reject",
            "source/null": "reject",
            "source/swap": "reject",
            "source/wrong-type": "reject",
            "ts/drop": "reject",
            "ts/null": "reject",
            "ts/swap": "accept",
            "ts/wrong-type": "reject",
          },
          "returns": {
            "initial": true,
            "kind": "presence_changed",
            "network_id": 1,
            "nick": "sample",
            "presence": "online",
            "source": "monitor",
            "ts": "sample",
          },
        },
        {
          "arm": "presence_error",
          "matrix": {
            "detail/drop": "reject",
            "detail/null": "reject",
            "detail/swap": "accept",
            "detail/wrong-type": "reject",
            "network_id/drop": "reject",
            "network_id/null": "reject",
            "network_id/wrong-type": "reject",
            "reason/drop": "reject",
            "reason/null": "reject",
            "reason/swap": "reject",
            "reason/wrong-type": "reject",
          },
          "returns": {
            "detail": "sample",
            "kind": "presence_error",
            "network_id": 1,
            "reason": "list_full",
          },
        },
        {
          "arm": "presence_snapshot",
          "matrix": {
            "network_id/drop": "reject",
            "network_id/null": "reject",
            "network_id/wrong-type": "reject",
            "nicks.key/drop": "accept",
            "nicks.key/null": "reject",
            "nicks.key/swap": "reject",
            "nicks.key/wrong-type": "reject",
            "nicks/drop": "reject",
            "nicks/null": "reject",
            "nicks/wrong-type": "reject",
          },
          "returns": {
            "kind": "presence_snapshot",
            "network_id": 1,
            "nicks": {
              "key": "online",
            },
          },
        },
        {
          "arm": "query_windows_list",
          "matrix": {
            "windows.key.0.network_id/drop": "reject",
            "windows.key.0.network_id/null": "reject",
            "windows.key.0.network_id/wrong-type": "reject",
            "windows.key.0.opened_at/drop": "reject",
            "windows.key.0.opened_at/null": "reject",
            "windows.key.0.opened_at/swap": "accept",
            "windows.key.0.opened_at/wrong-type": "reject",
            "windows.key.0.target_nick/drop": "reject",
            "windows.key.0.target_nick/null": "reject",
            "windows.key.0.target_nick/swap": "accept",
            "windows.key.0.target_nick/wrong-type": "reject",
            "windows.key.0/drop": "accept",
            "windows.key.0/null": "reject",
            "windows.key.0/wrong-type": "reject",
            "windows.key/drop": "accept",
            "windows.key/null": "reject",
            "windows.key/wrong-type": "reject",
            "windows/drop": "reject",
            "windows/null": "reject",
            "windows/wrong-type": "reject",
          },
          "returns": {
            "kind": "query_windows_list",
            "windows": {
              "key": [
                {
                  "network_id": 1,
                  "opened_at": "sample",
                  "target_nick": "sample",
                },
              ],
            },
          },
        },
        {
          "arm": "recover_progress",
          "matrix": {
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
            "reason/drop": "reject",
            "reason/null": "accept",
            "reason/swap": "accept",
            "reason/wrong-type": "reject",
            "status/drop": "reject",
            "status/null": "reject",
            "status/swap": "reject",
            "status/wrong-type": "reject",
            "step/drop": "reject",
            "step/null": "reject",
            "step/swap": "reject",
            "step/wrong-type": "reject",
          },
          "returns": {
            "kind": "recover_progress",
            "network": "sample",
            "reason": "wrong_password",
            "status": "running",
            "step": "identify",
          },
        },
        {
          "arm": "recover_result",
          "matrix": {
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
            "outcome/drop": "reject",
            "outcome/null": "reject",
            "outcome/swap": "reject",
            "outcome/wrong-type": "reject",
            "reason/drop": "reject",
            "reason/null": "accept",
            "reason/swap": "accept",
            "reason/wrong-type": "reject",
          },
          "returns": {
            "kind": "recover_result",
            "network": "sample",
            "outcome": "succeeded",
            "reason": "wrong_password",
          },
        },
        {
          "arm": "server_reply",
          "matrix": {
            "lines.0/drop": "accept",
            "lines.0/null": "reject",
            "lines.0/swap": "accept",
            "lines.0/wrong-type": "reject",
            "lines/drop": "reject",
            "lines/null": "reject",
            "lines/wrong-type": "reject",
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
            "source/drop": "reject",
            "source/null": "reject",
            "source/swap": "reject",
            "source/wrong-type": "reject",
          },
          "returns": {
            "kind": "server_reply",
            "lines": [
              "sample",
            ],
            "network": "sample",
            "source": "info",
          },
        },
        {
          "arm": "session_identity_changed",
          "matrix": {
            "account/drop": "reject",
            "account/null": "accept",
            "account/swap": "accept",
            "account/wrong-type": "reject",
            "identified/drop": "reject",
            "identified/null": "reject",
            "identified/wrong-type": "reject",
            "network_id/drop": "reject",
            "network_id/null": "reject",
            "network_id/wrong-type": "reject",
          },
          "returns": {
            "account": "sample",
            "identified": true,
            "kind": "session_identity_changed",
            "network_id": 1,
          },
        },
        {
          "arm": "supported_umodes_changed",
          "matrix": {
            "modes.0/drop": "accept",
            "modes.0/null": "reject",
            "modes.0/swap": "accept",
            "modes.0/wrong-type": "reject",
            "modes/drop": "reject",
            "modes/null": "reject",
            "modes/wrong-type": "reject",
            "network_id/drop": "reject",
            "network_id/null": "reject",
            "network_id/wrong-type": "reject",
          },
          "returns": {
            "kind": "supported_umodes_changed",
            "modes": [
              "sample",
            ],
            "network_id": 1,
          },
        },
        {
          "arm": "umode_changed",
          "matrix": {
            "modes.0/drop": "accept",
            "modes.0/null": "reject",
            "modes.0/swap": "accept",
            "modes.0/wrong-type": "reject",
            "modes/drop": "reject",
            "modes/null": "reject",
            "modes/wrong-type": "reject",
            "network_id/drop": "reject",
            "network_id/null": "reject",
            "network_id/wrong-type": "reject",
          },
          "returns": {
            "kind": "umode_changed",
            "modes": [
              "sample",
            ],
            "network_id": 1,
          },
        },
        {
          "arm": "web_session_severed",
          "matrix": {
            "code/drop": "reject",
            "code/null": "reject",
            "code/swap": "accept",
            "code/wrong-type": "reject",
          },
          "returns": {
            "code": "rate_limit_flood",
            "kind": "web_session_severed",
          },
        },
        {
          "arm": "who_reply",
          "matrix": {
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
            "target/drop": "reject",
            "target/null": "reject",
            "target/swap": "accept",
            "target/wrong-type": "reject",
            "users.0.channel/drop": "reject",
            "users.0.channel/null": "reject",
            "users.0.channel/swap": "accept",
            "users.0.channel/wrong-type": "reject",
            "users.0.hops/drop": "reject",
            "users.0.hops/null": "accept",
            "users.0.hops/wrong-type": "reject",
            "users.0.host/drop": "reject",
            "users.0.host/null": "reject",
            "users.0.host/swap": "accept",
            "users.0.host/wrong-type": "reject",
            "users.0.modes/drop": "reject",
            "users.0.modes/null": "reject",
            "users.0.modes/swap": "accept",
            "users.0.modes/wrong-type": "reject",
            "users.0.nick/drop": "reject",
            "users.0.nick/null": "reject",
            "users.0.nick/swap": "accept",
            "users.0.nick/wrong-type": "reject",
            "users.0.realname/drop": "reject",
            "users.0.realname/null": "accept",
            "users.0.realname/swap": "accept",
            "users.0.realname/wrong-type": "reject",
            "users.0.server/drop": "reject",
            "users.0.server/null": "reject",
            "users.0.server/swap": "accept",
            "users.0.server/wrong-type": "reject",
            "users.0.user/drop": "reject",
            "users.0.user/null": "reject",
            "users.0.user/swap": "accept",
            "users.0.user/wrong-type": "reject",
            "users.0/drop": "accept",
            "users.0/null": "reject",
            "users.0/wrong-type": "reject",
            "users/drop": "reject",
            "users/null": "reject",
            "users/wrong-type": "reject",
          },
          "returns": {
            "kind": "who_reply",
            "network": "sample",
            "target": "sample",
            "users": [
              {
                "channel": "sample",
                "hops": 1,
                "host": "sample",
                "modes": "sample",
                "nick": "sample",
                "realname": "sample",
                "server": "sample",
                "user": "sample",
              },
            ],
          },
        },
        {
          "arm": "whois_bundle",
          "matrix": {
            "account/drop": "reject",
            "account/null": "accept",
            "account/swap": "accept",
            "account/wrong-type": "reject",
            "actually_host/drop": "reject",
            "actually_host/null": "accept",
            "actually_host/swap": "accept",
            "actually_host/wrong-type": "reject",
            "actually_ip/drop": "reject",
            "actually_ip/null": "accept",
            "actually_ip/swap": "accept",
            "actually_ip/wrong-type": "reject",
            "avatar_url/drop": "accept",
            "avatar_url/null": "accept",
            "avatar_url/swap": "accept",
            "avatar_url/wrong-type": "reject",
            "away_message/drop": "reject",
            "away_message/null": "accept",
            "away_message/swap": "accept",
            "away_message/wrong-type": "reject",
            "certfp/drop": "reject",
            "certfp/null": "accept",
            "certfp/swap": "accept",
            "certfp/wrong-type": "reject",
            "channels.0/drop": "accept",
            "channels.0/null": "reject",
            "channels.0/swap": "accept",
            "channels.0/wrong-type": "reject",
            "channels/drop": "reject",
            "channels/null": "accept",
            "channels/wrong-type": "reject",
            "extra_lines.0.numeric/drop": "reject",
            "extra_lines.0.numeric/null": "reject",
            "extra_lines.0.numeric/wrong-type": "reject",
            "extra_lines.0.text/drop": "reject",
            "extra_lines.0.text/null": "reject",
            "extra_lines.0.text/swap": "accept",
            "extra_lines.0.text/wrong-type": "reject",
            "extra_lines.0/drop": "accept",
            "extra_lines.0/null": "reject",
            "extra_lines.0/wrong-type": "reject",
            "extra_lines/drop": "reject",
            "extra_lines/null": "accept",
            "extra_lines/wrong-type": "reject",
            "host/drop": "reject",
            "host/null": "accept",
            "host/swap": "accept",
            "host/wrong-type": "reject",
            "idle_seconds/drop": "reject",
            "idle_seconds/null": "accept",
            "idle_seconds/wrong-type": "reject",
            "is_admin/drop": "reject",
            "is_admin/null": "reject",
            "is_admin/wrong-type": "reject",
            "is_agent/drop": "reject",
            "is_agent/null": "reject",
            "is_agent/wrong-type": "reject",
            "is_chanop/drop": "reject",
            "is_chanop/null": "reject",
            "is_chanop/wrong-type": "reject",
            "is_helper/drop": "reject",
            "is_helper/null": "reject",
            "is_helper/wrong-type": "reject",
            "is_java/drop": "reject",
            "is_java/null": "reject",
            "is_java/wrong-type": "reject",
            "is_operator/drop": "reject",
            "is_operator/null": "reject",
            "is_operator/wrong-type": "reject",
            "is_registered/drop": "reject",
            "is_registered/null": "reject",
            "is_registered/wrong-type": "reject",
            "is_services_admin/drop": "reject",
            "is_services_admin/null": "reject",
            "is_services_admin/wrong-type": "reject",
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
            "oper_text/drop": "reject",
            "oper_text/null": "accept",
            "oper_text/swap": "accept",
            "oper_text/wrong-type": "reject",
            "realname/drop": "reject",
            "realname/null": "accept",
            "realname/swap": "accept",
            "realname/wrong-type": "reject",
            "secure/drop": "reject",
            "secure/null": "reject",
            "secure/wrong-type": "reject",
            "secure_cipher/drop": "reject",
            "secure_cipher/null": "accept",
            "secure_cipher/swap": "accept",
            "secure_cipher/wrong-type": "reject",
            "server/drop": "reject",
            "server/null": "accept",
            "server/swap": "accept",
            "server/wrong-type": "reject",
            "server_info/drop": "reject",
            "server_info/null": "accept",
            "server_info/swap": "accept",
            "server_info/wrong-type": "reject",
            "signon/drop": "reject",
            "signon/null": "accept",
            "signon/wrong-type": "reject",
            "source/drop": "accept",
            "source/null": "accept",
            "source/swap": "accept",
            "source/wrong-type": "accept",
            "target/drop": "reject",
            "target/null": "reject",
            "target/swap": "accept",
            "target/wrong-type": "reject",
            "umodes/drop": "reject",
            "umodes/null": "accept",
            "umodes/swap": "accept",
            "umodes/wrong-type": "reject",
            "user/drop": "reject",
            "user/null": "accept",
            "user/swap": "accept",
            "user/wrong-type": "reject",
            "using_ssl/drop": "reject",
            "using_ssl/null": "reject",
            "using_ssl/wrong-type": "reject",
          },
          "returns": {
            "account": "sample",
            "actually_host": "sample",
            "actually_ip": "sample",
            "avatar_url": "sample",
            "away_message": "sample",
            "certfp": "sample",
            "channels": [
              "sample",
            ],
            "extra_lines": [
              {
                "numeric": 1,
                "text": "sample",
              },
            ],
            "host": "sample",
            "idle_seconds": 1,
            "is_admin": true,
            "is_agent": true,
            "is_chanop": true,
            "is_helper": true,
            "is_java": true,
            "is_operator": true,
            "is_registered": true,
            "is_services_admin": true,
            "kind": "whois_bundle",
            "network": "sample",
            "oper_text": "sample",
            "realname": "sample",
            "secure": true,
            "secure_cipher": "sample",
            "server": "sample",
            "server_info": "sample",
            "signon": 1,
            "source": "user",
            "target": "sample",
            "umodes": "sample",
            "user": "sample",
            "using_ssl": true,
          },
        },
        {
          "arm": "whowas_bundle",
          "matrix": {
            "host/drop": "reject",
            "host/null": "accept",
            "host/swap": "accept",
            "host/wrong-type": "reject",
            "logoff_time/drop": "reject",
            "logoff_time/null": "accept",
            "logoff_time/swap": "accept",
            "logoff_time/wrong-type": "reject",
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
            "not_found/drop": "reject",
            "not_found/null": "reject",
            "not_found/wrong-type": "reject",
            "realname/drop": "reject",
            "realname/null": "accept",
            "realname/swap": "accept",
            "realname/wrong-type": "reject",
            "server/drop": "reject",
            "server/null": "accept",
            "server/swap": "accept",
            "server/wrong-type": "reject",
            "target/drop": "reject",
            "target/null": "reject",
            "target/swap": "accept",
            "target/wrong-type": "reject",
            "user/drop": "reject",
            "user/null": "accept",
            "user/swap": "accept",
            "user/wrong-type": "reject",
          },
          "returns": {
            "host": "sample",
            "kind": "whowas_bundle",
            "logoff_time": "sample",
            "network": "sample",
            "not_found": true,
            "realname": "sample",
            "server": "sample",
            "target": "sample",
            "user": "sample",
          },
        },
        {
          "arm": "window_invite_declined",
          "matrix": {
            "channel/drop": "reject",
            "channel/null": "reject",
            "channel/swap": "accept",
            "channel/wrong-type": "reject",
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
          },
          "returns": {
            "channel": "sample",
            "kind": "window_invite_declined",
            "network": "sample",
          },
        },
        {
          "arm": "window_invited",
          "matrix": {
            "channel/drop": "reject",
            "channel/null": "reject",
            "channel/swap": "accept",
            "channel/wrong-type": "reject",
            "inviter/drop": "reject",
            "inviter/null": "reject",
            "inviter/swap": "accept",
            "inviter/wrong-type": "reject",
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
            "state/drop": "reject",
            "state/null": "reject",
            "state/swap": "reject",
            "state/wrong-type": "reject",
          },
          "returns": {
            "channel": "sample",
            "inviter": "sample",
            "kind": "window_invited",
            "network": "sample",
            "state": "invited",
          },
        },
        {
          "arm": "window_pending",
          "matrix": {
            "channel/drop": "reject",
            "channel/null": "reject",
            "channel/swap": "accept",
            "channel/wrong-type": "reject",
            "network/drop": "reject",
            "network/null": "reject",
            "network/swap": "accept",
            "network/wrong-type": "reject",
            "state/drop": "reject",
            "state/null": "reject",
            "state/swap": "reject",
            "state/wrong-type": "reject",
          },
          "returns": {
            "channel": "sample",
            "kind": "window_pending",
            "network": "sample",
            "state": "pending",
          },
        },
      ]
    `);
  });

  // Every (arm, path, op) the census measured as a hole, against the table.
  // Two-sided on purpose: one direction alone is not an oracle. Without
  // `unexplained` a new undeclared tolerance lands silently; without `stale`
  // a tolerance can be REMOVED — "sanitised into agreement", which the
  // ruling forbids — and the table would keep asserting a reason for a
  // divergence that no longer exists.
  //
  // The reverse-direction column (`schemaAcceptsHandRejects`) is not folded
  // in: its only occurrence is `web_session_severed` against
  // `S_AdminEventsWireWebSessionSeveredEvent`, the OTHER Wire module that
  // emits this kind literal, whose sample the user-topic arm rightly
  // rejects. That is the candidate ambiguity, not a tolerance — and it is
  // already pinned, verbatim, in the census snapshot above.
  it("declares every measured tolerance, and declares nothing it did not measure", () => {
    const observed = new Set<string>();
    for (const kind of ARMS.filter(accepts)) {
      for (const { name, node } of candidatesFor(kind)) {
        const report = censusArm(kind, name, node);
        if (report.handAcceptsSchemaRejects === "-") continue;
        for (const label of report.handAcceptsSchemaRejects.split(", ")) {
          observed.add(`${kind} ${label}`);
        }
      }
    }

    const declared = new Set<string>();
    for (const [arm, paths] of Object.entries(DECLARED_TOLERANCES)) {
      for (const [path, entry] of Object.entries<Declared>(paths)) {
        for (const op of entry.ops) declared.add(`${arm} ${path}/${op}`);
      }
    }

    expect({
      measured: observed.size,
      declared: declared.size,
      unexplained: [...observed].filter((k) => !declared.has(k)).sort(),
      stale: [...declared].filter((k) => !observed.has(k)).sort(),
    }).toMatchInlineSnapshot(`
      {
        "declared": 60,
        "measured": 60,
        "stale": [],
        "unexplained": [],
      }
    `);
  });

  // The citation, made load-bearing. A `why` nobody can fail is decoration;
  // this is the part a deletion reddens. Each `quote` resolves to exactly
  // one line in the file it names (verified when the table was written), so
  // removing the comment that justifies a tolerance — the cheapest way to
  // quietly un-declare one — shows up here rather than nowhere.
  // A test whose green is a `tsc` fact, not a runtime one: the annotation is
  // the assertion, and the body only gives it somewhere to live (a bare
  // `_Assert_*` alias is `noExportsInTest` if exported and TS6196 if not).
  // Should the runtime table stop covering an arm or a field the type-level
  // registry exempts, `TypeWideningIsDeclaredAtRuntime` resolves to `false`
  // and this line stops compiling.
  it("subsumes the type-level widening registry, arm and field", () => {
    const subsumed: TypeWideningIsDeclaredAtRuntime = true;
    expect(subsumed).toBe(true);
  });

  it("keeps every declared reason present in the guard it cites", () => {
    const missing = Object.entries(DECLARED_TOLERANCES).flatMap(([arm, paths]) =>
      Object.entries<Declared>(paths)
        .filter(([, entry]) => !GUARD_SOURCE[entry.file].includes(entry.quote))
        .map(([path, entry]) => `${arm} ${path} → ${entry.file}: ${entry.quote}`),
    );
    expect(missing).toMatchInlineSnapshot(`[]`);
  });

  // What the ruling asks to be REPORTED rather than closed, derived from the
  // table instead of restated beside it.
  //
  // `widerThanItsWrittenReason` is the class this issue's own earlier slice
  // already closed once, on `banlist_bundle.mode` (5703d301): a guard
  // written for an ABSENT key that also swallows a PRESENT mangled one. It
  // is not the additive-vintage tolerance the #447 posture covers, and vjt's
  // ruling — *if the behaviour is correct, we do not change it* — does not
  // reach it, because whether it is correct is exactly what is unsettled.
  // Named here, unchanged, until vjt rules per arm.
  //
  // `noWrittenReason` is the group the ruling says to report and not touch.
  //
  // A number moving in this snapshot is a REPORT changing, not a gate
  // breaking: closing one of these is a behaviour change and needs its own
  // ruling, and widening a comment to cover the case it already handles is
  // a legitimate way to move an entry from the first list to `deliberate`.
  it("names the tolerances the ruling leaves open instead of closing them", () => {
    const entries = Object.entries(DECLARED_TOLERANCES).flatMap(([arm, paths]) =>
      Object.entries<Declared>(paths).map(([path, entry]) => ({ arm, path, ...entry })),
    );
    const beyondAbsence = (entry: (typeof entries)[number]) =>
      entry.ops.filter((op) => op !== "drop");

    expect({
      deliberate: entries.filter((e) => e.covers === "any-unusable-value").length,
      widerThanItsWrittenReason: entries
        .filter((e) => e.covers === "absent" && beyondAbsence(e).length > 0)
        .map((e) => `${e.arm} ${e.path}/${beyondAbsence(e).join("+")}`),
      noWrittenReason: entries.filter((e) => e.covers === "none").map((e) => `${e.arm} ${e.path}`),
    }).toMatchInlineSnapshot(`
      {
        "deliberate": 27,
        "noWrittenReason": [],
        "widerThanItsWrittenReason": [],
      }
    `);
  });

  // #1393d — the INVERSE register, and the reason it has to exist separately.
  //
  // `DECLARED_TOLERANCES` records where the hand guard is WIDER than the
  // schema. This slice created the opposite: an arm that calls `validate` and
  // then rejects a value the schema types as legal. `window_invited` types
  // `inviter` as a free `"s"`, so `""` passes the schema — and no IRC nick is
  // empty, so the guard drops it.
  //
  // The census cannot see this, and that is the whole hazard: its mutation
  // matrix produces absent / null / wrong-type / swap, never an empty string,
  // so the divergence is measured as parity. A reader diffing the guard
  // against the schema six months from now finds an unexplained extra check
  // and reads it as drift to tidy away. Named here so it reads as policy.
  //
  // Recorded in a table of its own rather than as a `DECLARED_TOLERANCES` row:
  // that table's contract is `measured === declared` against the observed
  // mutation set, and an entry the matrix can never observe would land in
  // `stale` forever. Same discipline though — the citation is load-bearing,
  // and it quotes the CHECK rather than the comment above it, because deleting
  // the check is the failure this exists to catch.
  const DECLARED_STRICTNESSES = [
    {
      arm: "window_invited",
      schema: "S_SessionWireWindowInvitedPayload",
      path: "inviter",
      value: "",
      file: "userTopic",
      quote: 'invited.inviter === "" ? null : invited',
      why: '#902 + #1393d — `""` IS a valid `String.t()`, so this is a policy STRICTER than the generated schema, not a consequence of it. The hand guard this arm replaced rejected an empty inviter, and dropping the check while migrating to `validate` would have been a silent strictness loss. An empty nick names nobody: it is present-and-unusable, the class the strict ruling rejects.',
    },
  ] as const;

  it("declares every policy stricter than its schema, and measures each one live", () => {
    const measured = DECLARED_STRICTNESSES.map((s) => {
      const node = candidatesFor(s.arm).find(({ name }) => name === s.schema)?.node;
      // Not defensive noise: `find` is how the schema is resolved by NAME
      // rather than by position, and a renamed schema must redden here rather
      // than silently measure nothing.
      if (node === undefined) throw new Error(`no schema ${s.schema} for arm ${s.arm}`);
      const payload = { ...(sample(node) as Record<string, unknown>), [s.path]: s.value };
      return {
        case: `${s.arm}.${s.path} = ${JSON.stringify(s.value)}`,
        // The divergence, both halves. Either one flipping means the policy
        // stopped being a policy: the schema tightening makes it redundant,
        // the guard loosening makes it gone.
        schemaAccepts: validate(node, payload) !== null,
        handRejects: verdict(hand, payload) === "reject",
        cited: GUARD_SOURCE[s.file].includes(s.quote),
      };
    });
    expect(measured).toMatchInlineSnapshot(`
      [
        {
          "case": "window_invited.inviter = """,
          "cited": true,
          "handRejects": true,
          "schemaAccepts": true,
        },
      ]
    `);
  });
});
