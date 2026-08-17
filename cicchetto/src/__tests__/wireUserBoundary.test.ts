import { describe, expect, it } from "vitest";
import { narrowUserEvent } from "../lib/userTopic";
import * as schemas from "../lib/wireSchema";
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
// — nothing to gain by swapping them. Arms where the hand narrower ACCEPTS
// what the schema rejects are permissiveness holes, and they are the only
// place a migration buys safety rather than line count.
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

function without(obj: Record<string, unknown>, field: string): Record<string, unknown> {
  const copy = { ...obj };
  delete copy[field];
  return copy;
}

function verdict(narrow: Narrower, payload: unknown): "accept" | "reject" {
  return narrow(payload) === null ? "reject" : "accept";
}

function isObjectNode(node: WireNode): node is { o: Record<string, WireNode> } {
  return typeof node !== "string" && "o" in node;
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
  fields: number;
  handAcceptsSchemaRejects: string;
  schemaRejectsValid: boolean;
};

function censusArm(kind: string, schemaName: string, node: WireNode): ArmReport {
  const generated: Narrower = (raw) => validate(node, raw);
  const valid = sample(node) as Record<string, unknown>;
  const fields = Object.keys(valid).filter((f) => f !== "kind");

  const holes: string[] = [];
  for (const f of fields) {
    for (const [label, mutated] of [
      ["drop", without(valid, f)],
      ["null", { ...valid, [f]: null }],
      ["wrong-type", { ...valid, [f]: wrongType(valid[f]) }],
    ] as const) {
      if (verdict(hand, mutated) === "accept" && verdict(generated, mutated) === "reject") {
        holes.push(`${f}/${label}`);
      }
    }
  }

  return {
    arm: kind,
    schema: schemaName,
    fields: fields.length,
    handAcceptsSchemaRejects: holes.length === 0 ? "-" : holes.join(", "),
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
        "censused": 42,
        "censusedNotInSwitch": [],
        "handArms": 42,
        "inSwitchNotCensused": [],
      }
    `);
  });

  it("censuses every hand-narrowed arm against its generated schema", () => {
    const handArms = ARMS.filter(accepts);
    const reports = handArms.flatMap((k) =>
      candidatesFor(k).map(({ name, node }) => censusArm(k, name, node)),
    );
    const holes = reports.filter((r) => r.handAcceptsSchemaRejects !== "-");
    expect({
      armsWithSchema: handArms.length,
      armsCensused: reports.length,
      brokenOracles: reports.filter((r) => r.schemaRejectsValid).map((r) => r.arm),
      holes,
    }).toMatchInlineSnapshot(`
      {
        "armsCensused": 43,
        "armsWithSchema": 42,
        "brokenOracles": [],
        "holes": [
          {
            "arm": "bundle_hash",
            "fields": 2,
            "handAcceptsSchemaRejects": "version/null, version/wrong-type",
            "schema": "S_CicWireBundleHashPayload",
            "schemaRejectsValid": false,
          },
          {
            "arm": "server_settings_changed",
            "fields": 2,
            "handAcceptsSchemaRejects": "http_host_aliases/drop, http_host_aliases/null, http_host_aliases/wrong-type",
            "schema": "S_ServerSettingsWireChangedPayload",
            "schemaRejectsValid": false,
          },
          {
            "arm": "banlist_bundle",
            "fields": 4,
            "handAcceptsSchemaRejects": "mode/drop, mode/null, mode/wrong-type",
            "schema": "S_SessionWireBanlistBundlePayload",
            "schemaRejectsValid": false,
          },
          {
            "arm": "isupport_changed",
            "fields": 15,
            "handAcceptsSchemaRejects": "list_modes_queryable/drop, list_modes_queryable/null, list_modes_queryable/wrong-type, prefix_order/drop, prefix_order/null, prefix_order/wrong-type, chantypes/drop, chantypes/null, chantypes/wrong-type, casemapping/drop, casemapping/null, casemapping/wrong-type, maxlist/drop, maxlist/null, maxlist/wrong-type, nicklen/drop, nicklen/wrong-type, channellen/drop, channellen/wrong-type, topiclen/drop, topiclen/wrong-type, frame_budget_base/drop, frame_budget_base/null, frame_budget_base/wrong-type",
            "schema": "S_SessionWireIsupportChangedPayload",
            "schemaRejectsValid": false,
          },
          {
            "arm": "links_bundle",
            "fields": 3,
            "handAcceptsSchemaRejects": "mask/drop",
            "schema": "S_SessionWireLinksBundlePayload",
            "schemaRejectsValid": false,
          },
          {
            "arm": "lusers_bundle",
            "fields": 13,
            "handAcceptsSchemaRejects": "total_users/drop, total_users/wrong-type, invisible/drop, invisible/wrong-type, servers/drop, servers/wrong-type, operators/drop, operators/wrong-type, unknown_connections/drop, unknown_connections/wrong-type, channels_formed/drop, channels_formed/wrong-type, local_clients/drop, local_clients/wrong-type, local_servers/drop, local_servers/wrong-type, current_local/drop, current_local/wrong-type, max_local/drop, max_local/wrong-type, current_global/drop, current_global/wrong-type, max_global/drop, max_global/wrong-type",
            "schema": "S_SessionWireLusersBundlePayload",
            "schemaRejectsValid": false,
          },
          {
            "arm": "whois_bundle",
            "fields": 30,
            "handAcceptsSchemaRejects": "source/drop, source/null, source/wrong-type, extra_lines/drop",
            "schema": "S_SessionWireWhoisBundlePayload",
            "schemaRejectsValid": false,
          },
          {
            "arm": "window_invited",
            "fields": 4,
            "handAcceptsSchemaRejects": "inviter/drop, inviter/null, inviter/wrong-type",
            "schema": "S_SessionWireWindowInvitedPayload",
            "schemaRejectsValid": false,
          },
        ],
      }
    `);
  });
});
