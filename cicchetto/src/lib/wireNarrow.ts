import type { MessageKind, ScrollbackMessage, WireChannelEvent } from "./api";
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

function narrowMembers(raw: unknown): MemberEntry[] | null {
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
      };
    // P-0e + P-0f: invite_ack moved from per-channel topic to
    // user-topic; narrowed in `narrowUserEvent` instead. Channel-
    // topic should never receive invite_ack post-P-0f; default arm
    // returns null to drop any stray.
    default:
      return null;
  }
}
