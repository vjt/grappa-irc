import type {
  AdminSnapshotPayload,
  AdmissionFlow,
  MessageKind,
  ScrollbackMessage,
  WhoUser,
  WireAdminEvent,
  WireChannelEvent,
} from "./api";
import type { ModesEntry, TopicEntry } from "./channelTopic";
import type { MemberEntry } from "./memberTypes";

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

const VALID_MESSAGE_KINDS: ReadonlySet<MessageKind> = new Set([
  "privmsg",
  "notice",
  "action",
  "join",
  "part",
  "quit",
  "nick_change",
  "mode",
  "topic",
  "kick",
  "server_event",
]);

function narrowScrollbackMessage(raw: unknown): ScrollbackMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.id !== "number" ||
    typeof r.network !== "string" ||
    typeof r.channel !== "string" ||
    typeof r.server_time !== "number" ||
    typeof r.kind !== "string" ||
    !VALID_MESSAGE_KINDS.has(r.kind as MessageKind) ||
    typeof r.sender !== "string" ||
    (r.body !== null && typeof r.body !== "string") ||
    typeof r.meta !== "object" ||
    r.meta === null
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
    out.push({ nick: e.nick, modes: e.modes as string[] });
  }
  return out;
}

// #169 — narrow the `who_reply` per-user rows. Superset of MemberEntry;
// `modes` is a raw WHO flags STRING (not a prefix list). `hops`/`realname`
// are nullable (RFC-violating servers may omit the trailing field). A single
// malformed element drops the whole payload (mirror of narrowMembers) so the
// modal never renders a half-typed row.
export function narrowWhoUsers(raw: unknown): WhoUser[] | null {
  if (!Array.isArray(raw)) return null;
  const out: WhoUser[] = [];
  for (const u of raw) {
    if (typeof u !== "object" || u === null) return null;
    const e = u as Record<string, unknown>;
    if (
      typeof e.nick !== "string" ||
      typeof e.user !== "string" ||
      typeof e.host !== "string" ||
      typeof e.server !== "string" ||
      typeof e.modes !== "string" ||
      typeof e.channel !== "string" ||
      (e.hops !== null && typeof e.hops !== "number") ||
      (e.realname !== null && typeof e.realname !== "string")
    ) {
      return null;
    }
    out.push({
      nick: e.nick,
      user: e.user,
      host: e.host,
      server: e.server,
      modes: e.modes,
      hops: e.hops as number | null,
      realname: e.realname as string | null,
      channel: e.channel,
    });
  }
  return out;
}

// REV-A H1 — shared narrower for the three window-state terminal-event
// arms (joined / join_failed / kicked). F1 (visitor-parity 2026-05-15)
// added a user-topic dual-broadcast of these three arms to close a
// subscribe-then-broadcast race, leaving the byte-identical shape
// narrowing duplicated across `narrowChannelEvent` here and
// `narrowUserEvent` in `userTopic.ts`. A future server-side field add
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
      numeric: number;
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
        typeof r.numeric !== "number"
      )
        return null;
      return {
        kind: "join_failed",
        network: r.network,
        channel: r.channel,
        state: "failed",
        reason: r.reason as string | null,
        numeric: r.numeric,
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
      // REV-A H1 — shared narrower across per-channel topic + user-topic
      // dual-broadcast (see `narrowWindowStateEvent` moduledoc above).
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
// `narrowAdminSnapshot` validates the `{events: WireAdminEvent[]}` outer
// shape AND every element. Either the whole snapshot validates or it
// drops — partial admission would corrupt the audit ring with malformed
// rows.
//
// Adding a new admin event arm:
//   1. Add to `WireAdminEvent` union in api.ts.
//   2. Add an arm to `narrowAdminEvent` here.
//   3. Add a dispatch case to `ingest()` in adminEvents.ts (tsc-enforced
//      via `assertNever`).
// The narrower's default-arm returning null is the runtime mirror of
// `assertNever` — unknown server kinds drop instead of crashing.

const VALID_ADMISSION_FLOWS: ReadonlySet<AdmissionFlow> = new Set([
  "login_fresh",
  "login_existing",
  "bootstrap_user",
  "bootstrap_visitor",
  "patch_network_connect",
]);

const VALID_SUBJECT_KINDS: ReadonlySet<"user" | "visitor"> = new Set(["user", "visitor"]);

const VALID_CIRCUIT_CLOSE_REASONS: ReadonlySet<"success" | "cooldown_expired"> = new Set([
  "success",
  "cooldown_expired",
]);

// Shared helpers — every admin arm carries `at: string`; most carry
// `network_id: number` + `network_slug: string | null`. Failing the
// shared shape early keeps the per-arm switches compact.

function isNonNullString(v: unknown): boolean {
  return typeof v === "string";
}

function isNullableString(v: unknown): boolean {
  return v === null || typeof v === "string";
}

function isNullableNumber(v: unknown): boolean {
  return v === null || typeof v === "number";
}

/**
 * Runtime narrower for admin-channel events (`WireAdminEvent` arms).
 * Mirror of `narrowChannelEvent` / `narrowUserEvent` for the admin
 * boundary. Returns the typed union variant on success or `null` on
 * any shape mismatch. Caller (adminEvents.ts) drops + logs on null.
 */
export function narrowAdminEvent(raw: unknown): WireAdminEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.kind !== "string") return null;
  if (!isNonNullString(r.at)) return null;
  switch (r.kind) {
    case "circuit_open":
      if (
        typeof r.network_id !== "number" ||
        !isNullableString(r.network_slug) ||
        typeof r.threshold !== "number" ||
        typeof r.cooldown_ms !== "number"
      )
        return null;
      return {
        kind: "circuit_open",
        network_id: r.network_id,
        network_slug: r.network_slug as string | null,
        threshold: r.threshold,
        cooldown_ms: r.cooldown_ms,
        at: r.at as string,
      };
    case "circuit_close":
      if (
        typeof r.network_id !== "number" ||
        !isNullableString(r.network_slug) ||
        typeof r.reason !== "string" ||
        !VALID_CIRCUIT_CLOSE_REASONS.has(r.reason as "success" | "cooldown_expired")
      )
        return null;
      return {
        kind: "circuit_close",
        network_id: r.network_id,
        network_slug: r.network_slug as string | null,
        reason: r.reason as "success" | "cooldown_expired",
        at: r.at as string,
      };
    case "capacity_reject":
      if (
        typeof r.flow !== "string" ||
        !VALID_ADMISSION_FLOWS.has(r.flow as AdmissionFlow) ||
        typeof r.error !== "string" ||
        typeof r.network_id !== "number" ||
        !isNullableString(r.network_slug) ||
        !isNullableString(r.client_id)
      )
        return null;
      return {
        kind: "capacity_reject",
        flow: r.flow as AdmissionFlow,
        error: r.error,
        network_id: r.network_id,
        network_slug: r.network_slug as string | null,
        client_id: r.client_id as string | null,
        at: r.at as string,
      };
    case "visitor_deleted":
      if (
        typeof r.visitor_id !== "string" ||
        !isNullableString(r.visitor_nick) ||
        !isNullableString(r.network_slug) ||
        !isNullableString(r.actor_user_id) ||
        !isNullableString(r.actor_user_name)
      )
        return null;
      return {
        kind: "visitor_deleted",
        visitor_id: r.visitor_id,
        visitor_nick: r.visitor_nick as string | null,
        network_slug: r.network_slug as string | null,
        actor_user_id: r.actor_user_id as string | null,
        actor_user_name: r.actor_user_name as string | null,
        at: r.at as string,
      };
    case "visitor_reaped":
      if (
        typeof r.visitor_id !== "string" ||
        !isNullableString(r.visitor_nick) ||
        !isNullableString(r.network_slug)
      )
        return null;
      return {
        kind: "visitor_reaped",
        visitor_id: r.visitor_id,
        visitor_nick: r.visitor_nick as string | null,
        network_slug: r.network_slug as string | null,
        at: r.at as string,
      };
    case "reaper_swept":
      if (typeof r.count !== "number") return null;
      return { kind: "reaper_swept", count: r.count, at: r.at as string };
    case "upload_reaped":
      if (
        typeof r.upload_id !== "string" ||
        typeof r.slug !== "string" ||
        typeof r.subject_kind !== "string" ||
        !VALID_SUBJECT_KINDS.has(r.subject_kind as "user" | "visitor") ||
        typeof r.subject_id !== "string"
      )
        return null;
      return {
        kind: "upload_reaped",
        upload_id: r.upload_id,
        slug: r.slug,
        subject_kind: r.subject_kind as "user" | "visitor",
        subject_id: r.subject_id,
        at: r.at as string,
      };
    case "uploads_swept":
      if (typeof r.count !== "number") return null;
      return { kind: "uploads_swept", count: r.count, at: r.at as string };
    case "session_disconnected":
    case "session_terminated": {
      if (
        typeof r.subject_kind !== "string" ||
        !VALID_SUBJECT_KINDS.has(r.subject_kind as "user" | "visitor") ||
        typeof r.subject_id !== "string" ||
        typeof r.network_id !== "number" ||
        !isNullableString(r.network_slug) ||
        !isNullableString(r.actor_user_id) ||
        !isNullableString(r.actor_user_name)
      )
        return null;
      const base = {
        subject_kind: r.subject_kind as "user" | "visitor",
        subject_id: r.subject_id,
        network_id: r.network_id,
        network_slug: r.network_slug as string | null,
        actor_user_id: r.actor_user_id as string | null,
        actor_user_name: r.actor_user_name as string | null,
        at: r.at as string,
      };
      return r.kind === "session_disconnected"
        ? { kind: "session_disconnected", ...base }
        : { kind: "session_terminated", ...base };
    }
    case "network_caps_updated":
      if (
        typeof r.network_id !== "number" ||
        typeof r.network_slug !== "string" ||
        !isNullableNumber(r.max_concurrent_visitor_sessions) ||
        !isNullableNumber(r.max_concurrent_user_sessions) ||
        !isNullableNumber(r.max_per_client) ||
        !isNullableString(r.actor_user_id) ||
        !isNullableString(r.actor_user_name)
      )
        return null;
      return {
        kind: "network_caps_updated",
        network_id: r.network_id,
        network_slug: r.network_slug,
        max_concurrent_visitor_sessions: r.max_concurrent_visitor_sessions as number | null,
        max_concurrent_user_sessions: r.max_concurrent_user_sessions as number | null,
        max_per_client: r.max_per_client as number | null,
        actor_user_id: r.actor_user_id as string | null,
        actor_user_name: r.actor_user_name as string | null,
        at: r.at as string,
      };
    case "circuit_reset":
      if (
        typeof r.network_id !== "number" ||
        !isNullableString(r.network_slug) ||
        !isNullableString(r.actor_user_id) ||
        !isNullableString(r.actor_user_name)
      )
        return null;
      return {
        kind: "circuit_reset",
        network_id: r.network_id,
        network_slug: r.network_slug as string | null,
        actor_user_id: r.actor_user_id as string | null,
        actor_user_name: r.actor_user_name as string | null,
        at: r.at as string,
      };
    case "user_created":
    case "user_updated":
      if (
        typeof r.user_id !== "string" ||
        typeof r.user_name !== "string" ||
        typeof r.is_admin !== "boolean" ||
        typeof r.actor_user_id !== "string" ||
        typeof r.actor_user_name !== "string"
      )
        return null;
      return {
        kind: r.kind,
        user_id: r.user_id,
        user_name: r.user_name,
        is_admin: r.is_admin,
        actor_user_id: r.actor_user_id,
        actor_user_name: r.actor_user_name,
        at: r.at as string,
      };
    case "user_password_changed":
    case "user_deleted":
      if (
        typeof r.user_id !== "string" ||
        typeof r.user_name !== "string" ||
        typeof r.actor_user_id !== "string" ||
        typeof r.actor_user_name !== "string"
      )
        return null;
      return {
        kind: r.kind,
        user_id: r.user_id,
        user_name: r.user_name,
        actor_user_id: r.actor_user_id,
        actor_user_name: r.actor_user_name,
        at: r.at as string,
      };
    case "network_created":
    case "network_deleted":
      if (
        typeof r.network_id !== "number" ||
        typeof r.network_slug !== "string" ||
        typeof r.actor_user_id !== "string" ||
        typeof r.actor_user_name !== "string"
      )
        return null;
      return {
        kind: r.kind,
        network_id: r.network_id,
        network_slug: r.network_slug,
        actor_user_id: r.actor_user_id,
        actor_user_name: r.actor_user_name,
        at: r.at as string,
      };
    case "server_added":
    case "server_updated":
      if (
        typeof r.network_id !== "number" ||
        typeof r.network_slug !== "string" ||
        typeof r.server_id !== "number" ||
        typeof r.host !== "string" ||
        typeof r.port !== "number" ||
        typeof r.tls !== "boolean" ||
        typeof r.actor_user_id !== "string" ||
        typeof r.actor_user_name !== "string"
      )
        return null;
      return {
        kind: r.kind,
        network_id: r.network_id,
        network_slug: r.network_slug,
        server_id: r.server_id,
        host: r.host,
        port: r.port,
        tls: r.tls,
        actor_user_id: r.actor_user_id,
        actor_user_name: r.actor_user_name,
        at: r.at as string,
      };
    case "server_removed":
      if (
        typeof r.network_id !== "number" ||
        typeof r.network_slug !== "string" ||
        typeof r.server_id !== "number" ||
        typeof r.host !== "string" ||
        typeof r.port !== "number" ||
        typeof r.actor_user_id !== "string" ||
        typeof r.actor_user_name !== "string"
      )
        return null;
      return {
        kind: "server_removed",
        network_id: r.network_id,
        network_slug: r.network_slug,
        server_id: r.server_id,
        host: r.host,
        port: r.port,
        actor_user_id: r.actor_user_id,
        actor_user_name: r.actor_user_name,
        at: r.at as string,
      };
    case "credential_bound":
      if (
        typeof r.user_id !== "string" ||
        typeof r.user_name !== "string" ||
        typeof r.network_id !== "number" ||
        typeof r.network_slug !== "string" ||
        typeof r.nick !== "string" ||
        typeof r.actor_user_id !== "string" ||
        typeof r.actor_user_name !== "string"
      )
        return null;
      return {
        kind: "credential_bound",
        user_id: r.user_id,
        user_name: r.user_name,
        network_id: r.network_id,
        network_slug: r.network_slug,
        nick: r.nick,
        actor_user_id: r.actor_user_id,
        actor_user_name: r.actor_user_name,
        at: r.at as string,
      };
    case "credential_updated":
      if (
        typeof r.user_id !== "string" ||
        typeof r.user_name !== "string" ||
        typeof r.network_id !== "number" ||
        typeof r.network_slug !== "string" ||
        typeof r.session_action !== "string" ||
        (r.session_action !== "left_alone" && r.session_action !== "stopped") ||
        typeof r.actor_user_id !== "string" ||
        typeof r.actor_user_name !== "string"
      )
        return null;
      return {
        kind: "credential_updated",
        user_id: r.user_id,
        user_name: r.user_name,
        network_id: r.network_id,
        network_slug: r.network_slug,
        session_action: r.session_action,
        actor_user_id: r.actor_user_id,
        actor_user_name: r.actor_user_name,
        at: r.at as string,
      };
    case "credential_unbound":
      if (
        typeof r.user_id !== "string" ||
        typeof r.user_name !== "string" ||
        typeof r.network_id !== "number" ||
        typeof r.network_slug !== "string" ||
        typeof r.actor_user_id !== "string" ||
        typeof r.actor_user_name !== "string"
      )
        return null;
      return {
        kind: "credential_unbound",
        user_id: r.user_id,
        user_name: r.user_name,
        network_id: r.network_id,
        network_slug: r.network_slug,
        actor_user_id: r.actor_user_id,
        actor_user_name: r.actor_user_name,
        at: r.at as string,
      };
    case "cap_counts_changed":
      // REV-H H5 (2026-05-22): network_slug is required non-null on
      // this arm. The server-side broadcaster early-returns when the
      // network row was deleted, so a nil-slug payload would already
      // never reach cic — narrowing it as required surfaces that
      // contract at the boundary instead of letting cic render
      // `net#{id}` for a payload that can't occur.
      if (
        typeof r.network_id !== "number" ||
        typeof r.network_slug !== "string" ||
        typeof r.visitors !== "number" ||
        typeof r.users !== "number" ||
        !isNullableNumber(r.max_concurrent_visitor_sessions) ||
        !isNullableNumber(r.max_concurrent_user_sessions)
      )
        return null;
      return {
        kind: "cap_counts_changed",
        network_id: r.network_id,
        network_slug: r.network_slug,
        visitors: r.visitors,
        users: r.users,
        max_concurrent_visitor_sessions: r.max_concurrent_visitor_sessions as number | null,
        max_concurrent_user_sessions: r.max_concurrent_user_sessions as number | null,
        at: r.at as string,
      };
    default:
      return null;
  }
}

/**
 * Runtime narrower for the admin-channel `snapshot` push payload.
 * Validates the `{events: [...]}` outer shape AND every element.
 * Atomic: a single malformed element drops the whole snapshot (avoids
 * corrupting the audit ring with mid-shape rows). Caller drops + logs
 * on null.
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
