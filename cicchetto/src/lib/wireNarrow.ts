import type {
  AdminSnapshotPayload,
  MessageKind,
  ScrollbackMessage,
  WireAdminEvent,
  WireChannelEvent,
} from "./api";
import type { ModesEntry, TopicEntry } from "./channelTopic";
import type { MemberEntry, MemberGender } from "./memberTypes";
// #429 — the generated RUNTIME schemas. `S_*` consts are the same typespecs
// `wireTypes.ts` mirrors at compile time, emitted as data so the boundary can
// enforce them after tsc has erased the types.
import {
  S_AccountsAdminWireIndexPayload,
  S_AccountsAdminWireT,
  S_AdminEventsWireEvent,
  S_AdminOverviewWireT,
  S_ChannelDirectoryWireIndexPayload,
  S_LiveIntrospectionAdminWireIndexPayload,
  S_MeJSONMeJson,
  S_NetworksFeaturedChannelsAdminWireIndexPayload,
  S_NetworksFeaturedChannelsAdminWireT,
  S_NetworksFeaturedChannelsWireIndexPayload,
  S_NetworksServersAdminWireIndexPayload,
  S_NetworksServersAdminWireT,
  S_NetworksWireChannelJson,
  S_NetworksWireCredentialJson,
  S_ScrollbackWireArchiveWireIndex,
  S_ScrollbackWireT,
  S_SessionLogWireListResult,
  S_SessionLogWireSessionsResult,
  S_SessionLogWireT,
  S_SessionWireMembersIndexPayload,
  S_ThemesWireActivePair,
  S_ThemesWireIndexPayload,
  S_ThemesWireT,
  S_VhostsAdminWireGrantJson,
  S_VhostsAdminWireVhostJson,
  S_VisitorsAdminWireIndexPayload,
} from "./wireSchema";
import type {
  AccountsAdminWireIndexPayload,
  AccountsAdminWireT,
  AdminOverviewWireT,
  ChannelDirectoryWireIndexPayload,
  LiveIntrospectionAdminWireIndexPayload,
  MeJSONMeJson,
  NetworksFeaturedChannelsAdminWireIndexPayload,
  NetworksFeaturedChannelsAdminWireT,
  NetworksFeaturedChannelsWireIndexPayload,
  NetworksServersAdminWireIndexPayload,
  NetworksServersAdminWireT,
  NetworksWireChannelJson,
  NetworksWireCredentialJson,
  ScrollbackWireArchiveWireIndex,
  ScrollbackWireT,
  SessionISupportCasemapping,
  SessionLogWireListResult,
  SessionLogWireSessionsResult,
  SessionLogWireT,
  SessionWireMembersIndexPayload,
  ThemesWireActivePair,
  ThemesWireIndexPayload,
  ThemesWireT,
  VhostsAdminWireGrantJson,
  VhostsAdminWireVhostJson,
  VisitorsAdminWireIndexPayload,
  WindowCountsSeverity,
} from "./wireTypes";
// #410 — the runtime allowlists derive from the codegen-emitted `as const`
// enum arrays, so each closed set has ONE source (the server typespec via
// wireTypes.ts), not a hand copy that can silently drift.
import {
  ADMIN_EVENTS_WIRE_LOGIN_THROTTLE_DOOR,
  ADMIN_EVENTS_WIRE_LOGIN_THROTTLE_SCOPE,
  SCROLLBACK_MESSAGE_KIND,
  WINDOW_COUNTS_SEVERITY,
} from "./wireTypes";
import type { Infer, WireMismatch, WireNode } from "./wireValidate";
import { describeMismatch, validate, validateDetailed } from "./wireValidate";

// #267 — narrow the window_counts severity to the closed union, defaulting
// to "none" for an unknown value (defensive: a stale server mid hot-reload
// must never null the whole event for a bad severity — the counts are the
// load-bearing part). #410 — the value set IS the codegen-emitted
// `WINDOW_COUNTS_SEVERITY` const (mirror of `Grappa.WindowCounts.severity/0`),
// not a hand copy.
function narrowSeverity(raw: unknown): WindowCountsSeverity {
  return typeof raw === "string" && (WINDOW_COUNTS_SEVERITY as readonly string[]).includes(raw)
    ? (raw as WindowCountsSeverity)
    : "none";
}

// Bucket G H4+U3 (codebase-review-2026-05-12): runtime narrowing for
// per-channel WS events. Companion to `userTopic.ts`'s
// `narrowUserEvent` (which closed the same gap on the user-topic
// boundary as cic M1).
//
// ## Why this file exists
//
// `WireChannelEvent` (api.ts) is a TypeScript-side discriminated union
// — strong type system contract, ZERO runtime enforcement. A malformed
// server push (kind valid but a required field missing or wrong-typed)
// would let the dispatch arm in `subscribe.ts` read `undefined` from
// the payload and either crash a setter (`seedTopic(key, undefined)`)
// or silently corrupt store state.
//
// Pre-bucket-G the per-channel handlers cast the raw Phoenix payload
// directly: `phx.on("event", (payload: WireChannelEvent) => { ... })`.
// The cast is a *lie*: phoenix.js types the second arg as `unknown`-
// shaped JSON; trusting it as `WireChannelEvent` skips runtime
// validation entirely. `userTopic.ts` already closed the equivalent
// gap (cic M1, CP16-era) for the user-topic; this file is the
// per-channel mirror.
//
// ## Why a separate file (lib/wireNarrow.ts) instead of inlining
//
// The narrower module is a leaf — no SolidJS effects, no module-level
// state, no reactive store imports. Keeping it separate from
// subscribe.ts (which carries the heavy reactive plumbing) makes the
// narrower trivially testable in isolation (vitest exercises each
// arm against valid + malformed shapes without spinning up createRoot).
// Same reason `mentionMatch.ts` and `nickEquals.ts` live as their own
// modules. The cluster-shape note in CP24 specifies a new
// `lib/wireNarrow.ts` module — this is the precedent for future
// per-topic narrowers (e.g. a `narrowAdminEvent` if Phase 5 grows the
// /admin LiveDashboard's WS surface).

// #410 — the runtime allowlist derives from the codegen-emitted
// `SCROLLBACK_MESSAGE_KIND` const (mirror of `Grappa.Scrollback.Message`'s
// `kind()` closed set). `MessageKind` (api.ts) is the type alias over the
// SAME const, so the compile-time union and this runtime Set share ONE
// source: a new server kind regenerates the const and flows to both — no
// hand map to keep in sync. (Pre-#410 an exhaustive `Record<MessageKind,
// true>` was hand-maintained and its keys built this Set — S14; the codegen
// const supersedes the hand exhaustiveness guard.)
const VALID_MESSAGE_KINDS: ReadonlySet<MessageKind> = new Set(SCROLLBACK_MESSAGE_KIND);

// S14 — shared runtime guard for the `Message.kind()` closed set. Used
// by `narrowScrollbackMessage` here and `narrowMentionsBundleMessage`
// in `userTopic.ts` so both Message-kind wire projections gate the
// same set (no second hand-maintained kind check).
export function isMessageKind(v: unknown): v is MessageKind {
  return typeof v === "string" && VALID_MESSAGE_KINDS.has(v as MessageKind);
}

function narrowScrollbackMessage(raw: unknown): ScrollbackMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.id !== "number" ||
    typeof r.network !== "string" ||
    typeof r.channel !== "string" ||
    typeof r.server_time !== "number" ||
    !isMessageKind(r.kind) ||
    typeof r.sender !== "string" ||
    (r.body !== null && typeof r.body !== "string") ||
    typeof r.meta !== "object" ||
    r.meta === null ||
    (r.dm_with !== undefined && r.dm_with !== null && typeof r.dm_with !== "string")
  )
    return null;
  return {
    id: r.id,
    network: r.network,
    channel: r.channel,
    server_time: r.server_time,
    kind: r.kind as MessageKind,
    sender: r.sender,
    body: r.body as string | null,
    meta: r.meta as Record<string, unknown>,
    // issue 1365 (protocol 36) — the DM discriminator `shouldNotify` reads.
    // Absent stays absent: a pre-36 server never sends it, and absent and
    // `null` are different statements (see `Scrollback.Wire.t`).
    ...(r.dm_with !== undefined && { dm_with: r.dm_with as string | null }),
  };
}

function narrowTopicEntry(raw: unknown): TopicEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    (r.text !== null && typeof r.text !== "string") ||
    (r.set_by !== null && typeof r.set_by !== "string") ||
    (r.set_at !== null && typeof r.set_at !== "string")
  )
    return null;
  return {
    text: r.text as string | null,
    set_by: r.set_by as string | null,
    set_at: r.set_at as string | null,
  };
}

function narrowModesEntry(raw: unknown): ModesEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.modes) || typeof r.params !== "object" || r.params === null) return null;
  for (const m of r.modes) {
    if (typeof m !== "string") return null;
  }
  return {
    modes: r.modes as string[],
    params: r.params as Record<string, string | null>,
  };
}

// #216 — a `string[]` (an ISUPPORT CHANMODES class or the like).
function narrowStringArray(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  for (const el of raw) {
    if (typeof el !== "string") return null;
  }
  return raw as string[];
}

// #216 — a `Record<string, string>` (the ISUPPORT PREFIX letter→sigil map).
function narrowStringRecord(raw: unknown): Record<string, string> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof val !== "string") return null;
    out[key] = val;
  }
  return out;
}

// #1255 — `CASEMAPPING` is a closed set server-side; an unmodelled value
// degrades to `ascii`, the same call `Grappa.Session.ISupport` makes (too
// lax beats merging identities the ircd keeps apart), so client and server
// cannot disagree about which fold a network got.
function narrowCasemapping(raw: unknown): SessionISupportCasemapping {
  return raw === "rfc1459" || raw === "rfc1459_strict" ? raw : "ascii";
}

// #1255 — a positive integer, or `null` for "unadvertised". Zero and
// negatives are not caps, they are values that would reject everything.
function narrowPositiveInt(raw: unknown): number | null {
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : null;
}

// #1255 — the MAXLIST caps: a letter→count map. A single bad entry voids
// the map rather than half-capping the modal from a payload we cannot
// trust; `null` lets the caller fall back to "no caps advertised".
function narrowNumberRecord(raw: unknown): Record<string, number> | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, number> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof val !== "number" || !Number.isInteger(val) || val <= 0) return null;
    out[key] = val;
  }
  return out;
}

// #216 — narrows the flat `isupport_changed` payload. Shared by the
// per-channel narrower (cold-WS-subscribe snapshot) AND the user-topic
// narrower (live 005 edge) — the event is dual-topic (see `WireChannelEvent`
// in api.ts). Returns the fully-typed union member or null on any mismatch.
export function narrowIsupportChanged(
  r: Record<string, unknown>,
): Extract<WireChannelEvent, { kind: "isupport_changed" }> | null {
  if (typeof r.network_id !== "number") return null;
  const a = narrowStringArray(r.chanmodes_a);
  const b = narrowStringArray(r.chanmodes_b);
  const c = narrowStringArray(r.chanmodes_c);
  const d = narrowStringArray(r.chanmodes_d);
  const prefix = narrowStringRecord(r.prefix);
  // #1393d — `list_modes_queryable` (#1251), `prefix_order` (#1302) and
  // `chantypes` (#1255) sat BELOW this guard behind a `?? <fallback>`, and
  // now sit in it, beside the CHANMODES classes they were always the same
  // shape as. All three are `[String.t()]` in
  // `Grappa.Session.Wire.isupport_changed_payload/0` — required and
  // non-nullable — and the emitter fills them on every emit, so there is no
  // grappa that omits one and no value a fallback could stand in for.
  //
  // Each of the three fallbacks was written for an ABSENT key and applied
  // itself to a PRESENT one carrying a null, a non-array or a mangled
  // element as well. That is the class 5703d301 closed on
  // `banlist_bundle.mode`, where a coerced `b` put an arbitrary list under
  // the "Bans" heading: the field is there, it is wrong, and we answer by
  // showing the user a value we made up and attributed to the server.
  //
  // The cross-version window those comments named was real and is now paid
  // for where it belongs — a `--cic`-only deploy leaves the BEAM behind and
  // the envelope is DROPPED rather than half-invented, which the drop
  // banner (`wireDrop.ts`) turns into something the operator can read.
  const listModesQueryable = narrowStringArray(r.list_modes_queryable);
  const prefixOrder = narrowStringArray(r.prefix_order);
  const chantypes = narrowStringArray(r.chantypes);
  if (
    a === null ||
    b === null ||
    c === null ||
    d === null ||
    prefix === null ||
    listModesQueryable === null ||
    prefixOrder === null ||
    chantypes === null
  )
    return null;
  return {
    kind: "isupport_changed",
    network_id: r.network_id,
    chanmodes_a: a,
    chanmodes_b: b,
    chanmodes_c: c,
    chanmodes_d: d,
    list_modes_queryable: listModesQueryable,
    prefix,
    prefix_order: prefixOrder,
    chantypes,
    casemapping: narrowCasemapping(r.casemapping),
    // No advertised cap and no advertised limit are the honest absent
    // states, so a malformed value degrades to them rather than to a
    // number nobody advertised.
    maxlist: narrowNumberRecord(r.maxlist) ?? {},
    nicklen: narrowPositiveInt(r.nicklen),
    channellen: narrowPositiveInt(r.channellen),
    topiclen: narrowPositiveInt(r.topiclen),
    // #1108 — absent or malformed means ABSENT, never a rejected envelope:
    // the /mode toggles this payload seeds must survive a server that
    // predates the budget, and cic's own rule for an unknown budget is to
    // show no warning at all.
    frame_budget_base: typeof r.frame_budget_base === "number" ? r.frame_budget_base : null,
  };
}

// M2 — the only 3 values `Grappa.Networks.Credential.genders/0` (and the
// wire's matching closed set) allow. Anything else (a future value grappa
// hasn't shipped a badge for yet, or malformed data) degrades to "unknown",
// same posture as `narrowCasemapping`'s unknown-value fallback elsewhere in
// this file — never a rejected envelope over one bad field.
function narrowMemberGender(raw: unknown): MemberGender | null {
  return raw === "male" || raw === "female" || raw === "nonbinary" ? raw : null;
}

export function narrowMembers(raw: unknown): MemberEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const out: MemberEntry[] = [];
  for (const m of raw) {
    if (typeof m !== "object" || m === null) return null;
    const e = m as Record<string, unknown>;
    if (typeof e.nick !== "string" || !Array.isArray(e.modes)) return null;
    for (const mode of e.modes) {
      if (typeof mode !== "string") return null;
    }
    out.push({ nick: e.nick, modes: e.modes as string[], gender: narrowMemberGender(e.gender) });
  }
  return out;
}

// #1393 — `narrowWhoUsers` lived here, next to `narrowMembers`, on the
// assumption that a `who_reply` row narrower would end up shared the way the
// member one is. It never was: the user topic was its only caller, and that
// arm now validates against `S_SessionWireWhoReplyPayload`, whose
// `{a: <who_user>}` is the same typespec this transcribed. Deleted rather
// than left exported — an unused export reads as a contract somebody keeps.

// REV-A H1 — shared narrower for the three window-state terminal-event
// arms (joined / join_failed / kicked). F1 (visitor-parity 2026-05-15)
// MOVED the live broadcast of these three arms to the user topic to
// close a subscribe-then-broadcast race, leaving the per-channel arms
// here to carry only the cold-subscribe snapshot — so the
// byte-identical shape narrowing is duplicated across
// `narrowChannelEvent` here and `narrowUserEvent` in `userTopic.ts`. A future server-side field add
// to e.g. `Session.Wire.kicked/4` would land at one site and silently
// drift at the other.
//
// Reuses the verb (single source for the wire shape), not the noun:
// the dispatch — routing to `setJoined / setFailed / setKicked` in
// `lib/windowState.ts` — stays at each call site (subscribe.ts +
// userTopic.ts) because the two narrowers feed different store keys
// (per-channel key vs user-topic key carrying the same payload).
//
// Returns the typed window-state union variant on success, `null` on
// any shape mismatch. Caller is expected to early-return on `null`
// (matches the surrounding `narrowChannelEvent` / `narrowUserEvent`
// convention).
export type WireWindowStateEvent =
  | { kind: "joined"; network: string; channel: string; state: "joined" }
  | {
      kind: "join_failed";
      network: string;
      channel: string;
      state: "failed";
      reason: string | null;
      // S13 — mirror the server typespec `join_failed_payload.numeric:
      // pos_integer() | nil`. The cold-subscribe snapshot builds this
      // via `Map.get(failure_numerics, channel)` = nil when the failing
      // numeric was never recorded; typing it non-null made the narrower
      // DROP the whole "failed tab" snapshot on reconnect (CP15-B3).
      numeric: number | null;
    }
  | {
      kind: "kicked";
      network: string;
      channel: string;
      state: "kicked";
      by: string | null;
      reason: string | null;
    };

export function narrowWindowStateEvent(raw: unknown): WireWindowStateEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.kind !== "string") return null;
  switch (r.kind) {
    case "joined":
      if (typeof r.network !== "string" || typeof r.channel !== "string" || r.state !== "joined")
        return null;
      return { kind: "joined", network: r.network, channel: r.channel, state: "joined" };
    case "join_failed":
      if (
        typeof r.network !== "string" ||
        typeof r.channel !== "string" ||
        r.state !== "failed" ||
        (r.reason !== null && typeof r.reason !== "string") ||
        // S13 — accept null (server contract permits it; see the type
        // above). Dropping on null regressed the reconnect "failed tab".
        (r.numeric !== null && typeof r.numeric !== "number")
      )
        return null;
      return {
        kind: "join_failed",
        network: r.network,
        channel: r.channel,
        state: "failed",
        reason: r.reason as string | null,
        numeric: r.numeric as number | null,
      };
    case "kicked":
      if (
        typeof r.network !== "string" ||
        typeof r.channel !== "string" ||
        r.state !== "kicked" ||
        (r.by !== null && typeof r.by !== "string") ||
        (r.reason !== null && typeof r.reason !== "string")
      )
        return null;
      return {
        kind: "kicked",
        network: r.network,
        channel: r.channel,
        state: "kicked",
        by: r.by as string | null,
        reason: r.reason as string | null,
      };
    default:
      return null;
  }
}

/**
 * Runtime narrower for per-channel WS events (`WireChannelEvent`
 * arms). Consumes the raw payload Phoenix.js delivers as `unknown`-
 * shaped JSON; returns the typed union variant on success or `null`
 * on any shape mismatch (kind missing/unknown, required field
 * missing/wrong-typed).
 *
 * Same boundary-validation pattern as `userTopic.ts`'s
 * `narrowUserEvent`. Caller drops + logs on `null` per the
 * `subscribe.ts` per-handler convention.
 */
export function narrowChannelEvent(raw: unknown): WireChannelEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.kind !== "string") return null;
  switch (r.kind) {
    case "message": {
      const message = narrowScrollbackMessage(r.message);
      if (message === null) return null;
      return { kind: "message", message };
    }
    case "topic_changed": {
      if (typeof r.network !== "string" || typeof r.channel !== "string") return null;
      const topic = narrowTopicEntry(r.topic);
      if (topic === null) return null;
      return { kind: "topic_changed", network: r.network, channel: r.channel, topic };
    }
    case "channel_modes_changed": {
      if (typeof r.network !== "string" || typeof r.channel !== "string") return null;
      const modes = narrowModesEntry(r.modes);
      if (modes === null) return null;
      return { kind: "channel_modes_changed", network: r.network, channel: r.channel, modes };
    }
    case "isupport_changed":
      // #216 — dual-topic event; the per-channel cold-snapshot pushes it
      // here, the live 005 edge on the user topic. Same flat shape both
      // ways (shared narrower).
      return narrowIsupportChanged(r);
    // UX-5 BJ (2026-05-19) — recognized-but-ignored. JoinBanner was the
    // only consumer; killed in BJ. Server still emits per-channel on
    // every 329 RPL_CREATIONTIME. Narrow + route to a no-op `case` in
    // `subscribe.ts` instead of letting it land in the default-null arm,
    // which would log `[subscribe] dropped malformed payload` on every
    // JOIN. See `WireChannelEvent` in api.ts for the policy.
    case "channel_created": {
      if (
        typeof r.network !== "string" ||
        typeof r.channel !== "string" ||
        typeof r.created_at !== "string"
      )
        return null;
      return {
        kind: "channel_created",
        network: r.network,
        channel: r.channel,
        created_at: r.created_at,
      };
    }
    case "members_seeded": {
      if (typeof r.network !== "string" || typeof r.channel !== "string") return null;
      const members = narrowMembers(r.members);
      if (members === null) return null;
      return { kind: "members_seeded", network: r.network, channel: r.channel, members };
    }
    case "joined":
    case "join_failed":
    case "kicked":
      // REV-A H1 — shared narrower across the per-channel cold snapshot
      // and the user-topic live broadcast (see `narrowWindowStateEvent`
      // moduledoc above).
      return narrowWindowStateEvent(r);
    case "read_cursor_set":
      if (typeof r.last_read_message_id !== "number") return null;
      return {
        kind: "read_cursor_set",
        last_read_message_id: r.last_read_message_id,
        // PWA icon badge door #3. Defensive default 0 if a stale server
        // (mid hot-reload) emits the event without it — the cursor sync,
        // the load-bearing part, must never drop for a badge reason.
        badge_count: typeof r.badge_count === "number" ? r.badge_count : 0,
      };
    // #267 — server-authoritative per-window count snapshot.
    case "window_counts": {
      if (
        typeof r.channel !== "string" ||
        typeof r.messages !== "number" ||
        typeof r.mentions !== "number" ||
        typeof r.events !== "number"
      )
        return null;
      return {
        kind: "window_counts",
        channel: r.channel,
        messages: r.messages,
        mentions: r.mentions,
        events: r.events,
        severity: narrowSeverity(r.severity),
      };
    }
    // P-0e + P-0f: invite_ack moved from per-channel topic to
    // user-topic; narrowed in `narrowUserEvent` instead. Channel-
    // topic should never receive invite_ack post-P-0f; default arm
    // returns null to drop any stray.
    default:
      return null;
  }
}

// ── REV-G H24 (2026-05-22) — admin-channel narrowers ───────────────
//
// `lib/adminEvents.ts` was using `channel.on("snapshot", (payload:
// AdminSnapshotPayload) => ...)` and `channel.on("event", (payload:
// WireAdminEvent) => ...)` direct casts — TypeScript-only contract,
// zero runtime enforcement. Sibling channels adopted `narrowChannelEvent`
// / `narrowUserEvent` for this exact boundary; admin path was missed.
//
// A malformed admin push (kind valid but field missing/wrong-typed) would
// either crash `ingest()` via the missing field read or silently corrupt
// the live `liveCountsByNetworkId` projection. The narrowers gate the
// boundary: shape mismatch → return null → caller drops + logs.
//
// #429 — the 27 arms below used to be transcribed BY HAND from the server's
// `Grappa.AdminEvents.Wire` typespecs: ~420 lines re-stating a shape the
// codegen already reads. They now run off `S_AdminEventsWireEvent`, emitted
// from those same typespecs by `mix grappa.gen_wire_types` and gated by the
// same `--check` drift check as `wireTypes.ts`.
//
// Transcription is not free: the hand version had NO `web_session_severed`
// arm, so every flood-sever audit row was dropped on the live push — and,
// because `narrowAdminSnapshot` is atomic, a single such row in the ring
// blanked the whole Events tab on reconnect. That arm exists on the server,
// in `wireTypes.ts` and in `adminEvents.ts`'s dispatch; only the hand copy
// lost it. Nobody could have noticed by reading the diff that omitted it.
// See the measured before/after in `__tests__/wireAdminBoundary.test.ts`.
//
// Adding a new admin event arm now: declare it in the server typespec, run
// the codegen, add a dispatch case to `ingest()` in adminEvents.ts
// (tsc-enforced via `assertNever`). Nothing to add HERE.

// A closed-set field the server marked `optional(:k)` AND that carries
// attribution DETAIL rather than the substance of the event.
//
// This is the part of a narrower a typespec cannot express, so it stays
// hand-written and named. `optional(:door)` tells the schema the server may
// OMIT the key; it cannot say what to do when a NEWER server sends a member
// this build has never heard of. `login_throttled` is a security alert whose
// door/scope are the attribution: dropping the alert to protect the detail
// inverts the priority, and the admin ring is mirrored to disk and replayed
// at boot, so rows minted by another vintage genuinely do arrive. Strip the
// unrecognised value, keep the alert — the judgement `narrowEnumMember` made
// inline before #429, now stated once.
const ADDITIVE_DETAIL_FIELDS: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>> = new Map(
  [
    [
      "login_throttled",
      new Map([
        ["door", ADMIN_EVENTS_WIRE_LOGIN_THROTTLE_DOOR as readonly string[]],
        ["scope", ADMIN_EVENTS_WIRE_LOGIN_THROTTLE_SCOPE as readonly string[]],
      ]),
    ],
  ],
);

function dropUnrecognisedDetails(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const r = raw as Record<string, unknown>;
  const details = typeof r.kind === "string" ? ADDITIVE_DETAIL_FIELDS.get(r.kind) : undefined;
  if (details === undefined) return raw;

  let out: Record<string, unknown> | null = null;
  for (const [field, allowed] of details) {
    const value = r[field];
    if (value === undefined) continue;
    if (typeof value === "string" && allowed.includes(value)) continue;
    out ??= { ...r };
    delete out[field];
  }
  return out ?? raw;
}

/**
 * Runtime narrower for admin-channel events (`WireAdminEvent` arms).
 * Mirror of `narrowChannelEvent` / `narrowUserEvent` for the admin
 * boundary. Returns the typed union variant on success or `null` on
 * any shape mismatch. Caller (adminEvents.ts) drops + logs on null.
 */
export function narrowAdminEvent(raw: unknown): WireAdminEvent | null {
  return validate(S_AdminEventsWireEvent, dropUnrecognisedDetails(raw));
}

/**
 * Runtime narrower for the admin-channel `snapshot` push payload.
 * Validates the `{events: [...]}` outer shape AND every element. Atomic: a
 * single malformed element drops the whole snapshot (avoids corrupting the
 * audit ring with mid-shape rows) — a policy call, not a shape, which is why
 * it is not `{ a: S_AdminEventsWireEvent }`. Caller drops + logs on null.
 */
export function narrowAdminSnapshot(raw: unknown): AdminSnapshotPayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.events)) return null;
  const events: WireAdminEvent[] = [];
  for (const el of r.events) {
    const narrowed = narrowAdminEvent(el);
    if (narrowed === null) return null;
    events.push(narrowed);
  }
  return { events };
}

// ── #215 — session-lifecycle-log narrower ──────────────────────────
//
// The session-log rides the SAME admin channel (`grappa:admin:events`)
// as the admin-events audit ring; the live push event name is
// `session_log_event` with payload `{kind, entry: SessionLogWireT}`.
// `sessionLog.ts` extracts `.entry` and narrows it here. Same
// boundary-validation contract as `narrowAdminEvent` — a malformed
// live push (field missing / wrong-typed) drops instead of crashing
// the store setter.

/**
 * Runtime narrower for the admin top bar's projection (`"overview"` push /
 * `GET /admin/overview`). Same REV-G H24 discipline as its siblings: the
 * caller (adminOverview.ts) drops + logs on null rather than trusting a cast.
 *
 * `loadavg` is checked as NULLABLE, and that is the load-bearing line.
 * `Grappa.AdminOverview.Wire` sends `nil` when `:cpu_sup` cannot be reached
 * because "cannot measure" is a different fact from "the box is idle";
 * demanding a number here would drop the whole payload exactly when the
 * sampler is down, blanking a bar whose other four stats are fine. #429 — the
 * typespec already says `integer() | nil`, so the generated schema carries
 * that nullability and no hand check has to remember it.
 */
export function narrowAdminOverview(raw: unknown): AdminOverviewWireT | null {
  return validate(S_AdminOverviewWireT, raw);
}

/**
 * Runtime narrower for a single `SessionLogWireT` row. Mirror of the
 * generated wire shape (`Grappa.SessionLog.Wire.t/0`). Returns the
 * typed row on success or `null` on any shape mismatch. Used by
 * `sessionLog.ts` on the live `session_log_event` push (the REST
 * snapshot trusts the server, same as the other `adminList*` helpers).
 *
 * #618/#429 — `old_nick` is the second policy residue on this boundary (the
 * first is `login_throttled`'s door/scope in `dropUnrecognisedDetails`). The
 * server declares it REQUIRED and always sends it, so the typespec is right
 * and the generated schema is right to demand it. But the field was ADDED
 * after this shape shipped, and cic deploys independently of the server
 * (`deploy-m42.sh --cic`): a cic ahead of its server would drop EVERY
 * session-log row over one field the peer predates. That is the additive-only
 * contract (#447) read from the client side, and no typespec can express it —
 * "required of a current server, tolerated absent from an older one" is a
 * statement about deploy skew, not about the shape. Default it and let the
 * row through.
 */
export function narrowSessionLogEntry(raw: unknown): SessionLogWireT | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  return validate(S_SessionLogWireT, r.old_nick === undefined ? { ...r, old_nick: null } : r);
}

// ── #1400 — the REST boundary ──────────────────────────────────────
//
// The narrowers above serve the WS edge, where `T | null` is the right shape
// because the caller drops the push and waits: `adminOverview.ts` states it —
// "A malformed push KEEPS the last good reading … the next honest tick is only
// an interval away". A REST response has no next tick. Handing the caller
// `null` would leave it with nothing and no way to say why, so the two edges
// need different failure MODES over the same schemas.
//
// The mode, per vjt's ruling on #1400: FAIL LOUD. A required field that the
// payload does not carry — the case a deploy window produces, cic newer than
// its server — makes the boundary reject the response and the surface fail
// VISIBLY. It does not fall through to `undefined` in a renderer. Extra fields
// stay harmless: the contract is additive (#447) and `validate` already ignores
// undeclared keys rather than rejecting them.
//
// ## The mode lives HERE, once
//
// `narrowRest` is the only place that decides what a REST shape mismatch does.
// The twelve narrowers below choose a schema and a label; none of them decides
// how to fail. Thirteen copies of a throw would be thirteen chances to soften
// one of them into a silent default.
//
// ## Where a tolerance goes, when one is needed
//
// Not into `narrowRest`, and not into a per-shape `if`. The house pattern is a
// WRAPPER around the validate call, named as policy — `old_nick` in
// `narrowSessionLogEntry` above is the worked example, and #1393 measured that
// exactly three of ~30 arms needed one. A field known to be new gets a wrapper
// that defaults it; everything else stays strict.
//
// ## What the conversion changes about the value
//
// A cast handed the caller the parsed body VERBATIM. `validate` hands back an
// object RECONSTRUCTED from the declared fields only (`walkObject`,
// `wireValidate.ts:223`). Any key the server sends that its own typespec does
// not declare is dropped here rather than travelling on unnoticed. Measured
// before this landed: across the twelve shapes, the twenty render paths behind
// them attach no such key — every one renders a `*.Wire` result and nothing
// else — so the reconstruction is shape-preserving today. It is not guaranteed
// to stay that way by anything but that measurement.

/**
 * A REST response whose shape the running bundle cannot read.
 *
 * Deliberately NOT an `ApiError`. That class carries a `code` from the server's
 * generated error-token set, and `friendlyApiError` maps it; minting a token
 * the server never emits would repeat the very defect #1400 records against
 * the hand-rolled `"Unauthorized"`. This is a client-side boundary rejection,
 * so it is its own class and `errorMessage` renders its `message` through the
 * plain-`Error` arm.
 *
 * ## It names the FIELD, not only the shape (issue 2199)
 *
 * It used to carry `shape` alone, so the modal read "the server sent a subject
 * profile this version of the app cannot read" and stopped there. A
 * self-hoster hit that on 1.5.8 — the release where `narrowMeResponse` made
 * `GET /me` validated at all — and the only move available was rolling the
 * package back to 1.5.7, which works because the old bundle does not check,
 * not because the payload was right. `mismatch` is the missing half.
 *
 * The prior sentence is KEPT and the detail APPENDED. It is the part that
 * tells a non-developer that the app and the server disagree, which is the
 * actionable fact for them; the path is for whoever reads the report.
 */
export class WireShapeError extends Error {
  readonly shape: string;
  readonly mismatch: WireMismatch;

  constructor(shape: string, mismatch: WireMismatch) {
    super(
      `the server sent a ${shape} this version of the app cannot read — ${describeMismatch(mismatch)}`,
    );
    this.name = "WireShapeError";
    this.shape = shape;
    this.mismatch = mismatch;
  }
}

/**
 * The REST failure mode, in one place. Validates `raw` against a generated
 * schema and THROWS on mismatch — see the section note above for why REST
 * cannot answer with `null` the way the WS narrowers do.
 *
 * `shape` names the wire shape, not the endpoint: the stack already carries
 * the call site, and one label per schema cannot drift out of step with the
 * twenty-four call sites the way twenty-four hand-written endpoint strings
 * could.
 */
function narrowRest<const N extends WireNode>(node: N, raw: unknown, shape: string): Infer<N> {
  const out = validateDetailed(node, raw);
  if (out.ok) return out.value;
  // Logged AS WELL AS thrown, and the duplication is the point (issue 2199).
  // The boot chain renders this error's message, but every other door hands
  // the throw to a catch that shows its own copy, or to none at all — and a
  // mismatch nobody can name is the defect, not the modal. The console line
  // is the one channel present on every path.
  console.error(`[grappa] wire: unreadable ${shape} — ${describeMismatch(out.mismatch)}`);
  throw new WireShapeError(shape, out.mismatch);
}

/** `GET /themes/:id`, `POST /themes`, `PATCH /themes/:id`, publish/unpublish/copy. */
export function narrowThemeResponse(raw: unknown): ThemesWireT {
  return narrowRest(S_ThemesWireT, raw, "theme");
}

/**
 * Every door that renders `NetworksJSON.update/1` — `PATCH /networks/:slug`,
 * `PATCH /networks/:slug/identity`, `PUT /networks/:slug/password`,
 * `PATCH /networks/:slug/profile`, `PUT` + `DELETE /networks/:slug/avatar`.
 *
 * Six controller actions, one `render(conn, :update, credential:)` each, one
 * `Wire.credential_to_json/1` behind them (issue 2135, measured on
 * `networks_controller.ex`). #1400 narrowed the first three and left the
 * last three casting; nothing distinguished them but which ones were looked
 * at.
 */
export function narrowCredentialResponse(raw: unknown): NetworksWireCredentialJson {
  return narrowRest(S_NetworksWireCredentialJson, raw, "network credential");
}

/**
 * `GET /me`, the widest renderer feed in the app.
 *
 * Issue 2135's A4, and the reason it is the first door of that slice rather
 * than a representative one: `home_data` draws HomePane, `read_cursors` +
 * `unread_counts` seed every sidebar badge and `badge_count` seeds the PWA
 * icon. A cast made all four `undefined` in a renderer on a response one
 * vintage behind; validation makes the surface fail where the fault is.
 *
 * The schema declares those four REQUIRED and cic's `MeResponse` marks them
 * optional. The server is the authority and it is not ambiguous: both arms
 * of `MeJSON.show/1` `Map.put` all four unconditionally. The optional marks
 * are a client-side convenience for test mocks (`wireTypesAssert.ts` says so
 * where it declines the full-shape pin), which is why this narrows against
 * the generated shape and leaves the hand-written type alone — the mirror is
 * A4 residue, not something this door can delete on its own.
 */
export function narrowMeResponse(raw: unknown): MeJSONMeJson {
  return narrowRest(S_MeJSONMeJson, raw, "subject profile");
}

/** `POST /admin/users`, `PATCH /admin/users/:id`, `PUT /admin/users/:id/password`. */
export function narrowAdminUserResponse(raw: unknown): AccountsAdminWireT {
  return narrowRest(S_AccountsAdminWireT, raw, "user");
}

/** `POST /admin/vhosts`, `PATCH /admin/vhosts/:id`. */
export function narrowAdminVhostResponse(raw: unknown): VhostsAdminWireVhostJson {
  return narrowRest(S_VhostsAdminWireVhostJson, raw, "vhost");
}

/** `POST /admin/vhosts/:id/grants`. */
export function narrowAdminVhostGrantResponse(raw: unknown): VhostsAdminWireGrantJson {
  return narrowRest(S_VhostsAdminWireGrantJson, raw, "vhost grant");
}

/** `POST` + `PUT /admin/networks/:id/servers[/:id]`. */
export function narrowAdminServerResponse(raw: unknown): NetworksServersAdminWireT {
  return narrowRest(S_NetworksServersAdminWireT, raw, "server");
}

/** `POST` + `PUT /admin/networks/:id/featured_channels[/:id]`. */
export function narrowAdminFeaturedChannelResponse(
  raw: unknown,
): NetworksFeaturedChannelsAdminWireT {
  return narrowRest(S_NetworksFeaturedChannelsAdminWireT, raw, "featured channel");
}

/**
 * The **201** arm of `POST /networks/:slug/channels/:channel/messages` only.
 *
 * That endpoint is a union discriminated by STATUS, not by a field: 202 carries
 * `%{ok: true}` — an ack for a send the server deliberately did not persist (a
 * `*Serv` target, `/notice` to a service, a no-persist CTCP). The caller reads
 * the status and never brings the 202 body here; there is no schema for it and
 * inventing one for two keys would be a second SSOT. See #1430.
 */
export function narrowMessageResponse(raw: unknown): ScrollbackWireT {
  return narrowRest(S_ScrollbackWireT, raw, "message");
}

/** `GET /admin/session_log`. */
export function narrowSessionLogListResponse(raw: unknown): SessionLogWireListResult {
  return narrowRest(S_SessionLogWireListResult, raw, "session log");
}

/** `GET /admin/session_log/sessions`. */
export function narrowSessionLogSessionsResponse(raw: unknown): SessionLogWireSessionsResult {
  return narrowRest(S_SessionLogWireSessionsResult, raw, "session list");
}

/** `GET /networks/:slug/featured`. */
export function narrowFeaturedChannelsResponse(
  raw: unknown,
): NetworksFeaturedChannelsWireIndexPayload {
  return narrowRest(S_NetworksFeaturedChannelsWireIndexPayload, raw, "featured channel list");
}

/** `GET /networks/:slug/directory`. */
export function narrowDirectoryPageResponse(raw: unknown): ChannelDirectoryWireIndexPayload {
  return narrowRest(S_ChannelDirectoryWireIndexPayload, raw, "channel directory page");
}

// ── #1400 slice 1 — the doors whose envelope was already generated ──
//
// The first tranche converted the doors whose response IS a single generated
// shape. These are the LIST doors, and #1400's body reads them as blocked:
// "the REST envelope types are hand-written mirrors in `api.ts` … that makes
// the first step emitting the missing envelope schemas". Measured at
// `236dd328`, that is true of most of the remaining casts and false of these
// nine: the codegen already emits five `*IndexPayload` types byte-identical
// to the `{ key: T[] }` written by hand in `api.ts`, plus the archive index —
// so `api.ts` was carrying a second copy of a shape that already existed,
// with a runtime schema already sitting beside it. Nothing is emitted here.
// The hand-written twins are deleted rather than pinned: an alias cannot
// drift, and a deleted type cannot either.
//
// The three bare-array doors take an inline `{ a: … }` node. That introduces
// no field NAME on this side — the array-ness is the wire's, and the element
// schema is the generated one — so it is not a mirror creeping back in.
//
// Same reconstruction caveat as the tranche above, and re-measured for these
// nine before landing: every element type here is a plain alias of its
// generated counterpart (`AdminUser = AccountsAdminWireT` and so on), so no
// consumer can even NAME a field the schema omits, and none of the eleven
// call sites behind them casts its way around that. Two shapes deliberately
// stay out of this slice for the opposite reason — `AdminNetwork` and
// `AdminCredential` INTERSECT extra fields onto their generated type
// (`circuit_state`, `live_counts`, `session_action`, `session_error`), which
// the server sends and the typespec does not declare, so validating them here
// would silently drop the four. They need the server-side declaration first.

/** `GET /admin/visitors`. */
export function narrowAdminVisitorsResponse(raw: unknown): VisitorsAdminWireIndexPayload {
  return narrowRest(S_VisitorsAdminWireIndexPayload, raw, "visitor list");
}

/** `GET /admin/sessions`. */
export function narrowAdminSessionsResponse(raw: unknown): LiveIntrospectionAdminWireIndexPayload {
  return narrowRest(S_LiveIntrospectionAdminWireIndexPayload, raw, "live session list");
}

/** `GET /admin/users`. */
export function narrowAdminUsersResponse(raw: unknown): AccountsAdminWireIndexPayload {
  return narrowRest(S_AccountsAdminWireIndexPayload, raw, "user list");
}

/** `GET /admin/networks/:id/servers`. */
export function narrowAdminServersResponse(raw: unknown): NetworksServersAdminWireIndexPayload {
  return narrowRest(S_NetworksServersAdminWireIndexPayload, raw, "server list");
}

/** `GET /admin/networks/:id/featured_channels`. */
export function narrowAdminFeaturedChannelsResponse(
  raw: unknown,
): NetworksFeaturedChannelsAdminWireIndexPayload {
  return narrowRest(
    S_NetworksFeaturedChannelsAdminWireIndexPayload,
    raw,
    "admin featured channel list",
  );
}

/** `GET /networks/:slug/archive`. */
export function narrowArchiveResponse(raw: unknown): ScrollbackWireArchiveWireIndex {
  return narrowRest(S_ScrollbackWireArchiveWireIndex, raw, "archive index");
}

/** `GET /networks/:slug/channels`. */
export function narrowChannelListResponse(raw: unknown): NetworksWireChannelJson[] {
  return narrowRest({ a: S_NetworksWireChannelJson }, raw, "channel list");
}

/**
 * `GET /networks/:slug/channels/:name/members`.
 *
 * #1680 — the REST twin of the `members_seeded` event. Both render through
 * `Grappa.Session.Wire.member/1` on purpose (bucket D), so the per-row shape
 * is one contract and this narrower reuses the GENERATED schema rather than
 * a second hand-written mirror.
 */
export function narrowMembersIndexResponse(raw: unknown): SessionWireMembersIndexPayload {
  return narrowRest(S_SessionWireMembersIndexPayload, raw, "members index");
}

/** `GET /networks/:slug/channels/:name/messages`, both the `before` and `after` pages. */
export function narrowMessagePageResponse(raw: unknown): ScrollbackWireT[] {
  return narrowRest({ a: S_ScrollbackWireT }, raw, "message page");
}

// ── #1400 — the themes envelopes, emitted for this slice ──
//
// Unlike slice 1, these two shapes did NOT already exist: `Grappa.Themes.Wire`
// published `t/0` alone, so the three listings and the day/night pair were the
// residual hand-written envelopes in `themesApi.ts`. Naming them at the wire
// boundary (`index_payload/0`, `active_pair/0`, each with the producing
// function the controllers now call) is what makes them generated shapes with
// a `--check` drift gate, instead of a client-side mirror.
//
// `active_pair` carries a same-module `t() | nil` in both slots. The moduledoc
// in `themes/wire.ex` records that `BuiltinBackgrounds.t/0` cannot be emitted
// for exactly that reason — a `user_type` reference the generator cannot
// resolve — but that limit belongs to the EXTERNAL-type path, which renders
// one alias at a time with no sibling registry. A type declared INSIDE a
// `*wire.ex` module is rendered by `render_typedef/2`, which publishes the
// module so the reference resolves; `NetworksWireConnectionInfo | null` was
// already on the tree as the precedent. So `GET /themes/backgrounds` stays
// cast and these two do not.

/** `GET /themes`, `GET /me/themes`, `GET /themes/unpublished`. */
export function narrowThemesResponse(raw: unknown): ThemesWireIndexPayload {
  return narrowRest(S_ThemesWireIndexPayload, raw, "theme list");
}

/** `PUT /me/theme`. */
export function narrowActiveThemePairResponse(raw: unknown): ThemesWireActivePair {
  return narrowRest(S_ThemesWireActivePair, raw, "active theme pair");
}

/**
 * `GET /me/theme`, which keeps its pre-existing tolerance for a bare `null`
 * body — a wrapper named as policy, per the section note above, so the
 * exception is visible rather than hidden inside the strict narrower the PUT
 * door shares.
 *
 * The tolerance is NOT reachable from this server: `MeThemeController.show`
 * answers `pair_wire/2`, which always emits both keys, so an unset pair is
 * `{light: null, dark: null}` and never `null`. It is carried forward
 * unexamined because retiring it is a behaviour change, not a cast removal.
 * Consequence worth stating plainly: a `null` body skips validation entirely,
 * so this door is fail-loud for every shape EXCEPT that one.
 */
export function narrowActiveThemePairOrEmpty(raw: unknown): ThemesWireActivePair {
  return raw === null ? { light: null, dark: null } : narrowActiveThemePairResponse(raw);
}
