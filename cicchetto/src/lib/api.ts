// Typed fetch client for the grappa REST surface. The wire shapes mirror
// `GrappaWeb.AuthJSON`, `GrappaWeb.MeJSON`, `GrappaWeb.NetworksJSON`,
// `GrappaWeb.ChannelsJSON`, and `GrappaWeb.FallbackController` — keep these
// types in lockstep with `lib/grappa/accounts/wire.ex`,
// `lib/grappa/networks/wire.ex`, `lib/grappa/scrollback/wire.ex`, and
// `lib/grappa_web/controllers/fallback_controller.ex`.
//
// Errors collapse to a single `ApiError` carrying the wire token (e.g.
// "invalid_credentials", "unauthorized") so callers branch on a stable
// snake_case string, matching the server's A7 envelope convention. The
// unauthenticated 401 from `Plugs.Authn` and the credential-failure 401
// from login both surface here as `ApiError`.

import type { ModesEntry, TopicEntry } from "./channelTopic";
import { getOrCreateClientId } from "./clientId";
import type { MemberEntry } from "./memberTypes";

function buildHeaders(token?: string): HeadersInit {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-grappa-client-id": getOrCreateClientId(),
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

export type LoginRequest = {
  identifier: string;
  password?: string;
  captcha_token?: string;
};

export type AdmissionError =
  | { error: "too_many_sessions" }
  | { error: "network_busy" }
  | { error: "network_unreachable"; retry_after?: number }
  | { error: "captcha_required"; site_key: string; provider: "turnstile" | "hcaptcha" | "disabled" }
  | { error: "captcha_failed" }
  | { error: "service_degraded" };

// Bucket G H2+U4 — unified 422 envelope for `Ecto.Changeset` failures
// emitted by `FallbackController`. The shape mirrors the existing A7
// `{error: "<token>"}` discriminator + ad-hoc top-level keys
// convention (see `AdmissionError` for the captcha_required pattern
// that already does this for `site_key`/`provider`).
//
// `field_errors` is the per-field error map produced by
// `Ecto.Changeset.traverse_errors/2`; values are `string[]` because a
// single field can carry multiple errors (e.g. `validate_required` +
// `validate_length` both fire on the same empty input). cic surfaces
// these via `err.info.field_errors` after `readError` populates
// `ApiError.info` with the parsed body.
export type ValidationError = {
  error: "validation_failed";
  field_errors: Record<string, string[]>;
};

export type Subject =
  | { kind: "user"; id: string; name: string }
  | { kind: "visitor"; id: string; nick: string; network_slug: string };

export type LoginResponse = {
  token: string;
  subject: Subject;
};

// Mirror of `GrappaWeb.MeJSON.show/1` (Task 30). Discriminated union
// over subject kind — extends the `Subject` shape from `LoginResponse`
// with a per-kind timestamp the SPA needs for surface rendering:
//
//   * user    → `inserted_at` (account-creation time, "member since").
//   * visitor → `expires_at`  (session-end UTC, drives countdown).
//
// Both encoded as ISO-8601 strings (server-side `:utc_datetime` /
// `:utc_datetime_usec` round-trip via Jason).
//
// Pre-Task-30 this was user-only `{id, name, inserted_at}` with no
// kind discriminator — visitor sessions 500'd at `/me`. The kind
// discriminator lets every consumer (Shell header, mention-match,
// ScrollbackPane self-highlight) dispatch on a single field instead
// of probing for `name` vs `nick`.
// CP29 R-3: `read_cursors` is the bulk envelope (`%{slug => %{chan =>
// id}}`) per plan O1. Hydrated once at login by `readCursor.ts`'s
// `applyMeEnvelope/1`. Empty `{}` for a fresh subject. Optional in the
// type so test mocks predating R-3 don't have to be touched — production
// /me always emits it (server-side `MeJSON.show/1` puts it on the
// envelope unconditionally).
export type ReadCursorsEnvelope = Record<string, Record<string, number>>;

export type MeResponse =
  | {
      kind: "user";
      id: string;
      name: string;
      inserted_at: string;
      read_cursors?: ReadCursorsEnvelope;
    }
  | {
      kind: "visitor";
      id: string;
      nick: string;
      network_slug: string;
      expires_at: string;
      read_cursors?: ReadCursorsEnvelope;
    };

// Display-nick for a `MeResponse` — `user.name` for users,
// `visitor.nick` for visitors. Centralizes the discriminant so
// callers (ScrollbackPane self-highlight, mention-match) don't
// repeat the per-kind branch. Mirror of server-side
// `auth.socketUserName()` selection at the rendering layer.
//
// **WARNING** — for "what is my IRC nick on THIS network", use
// `ownNickForNetwork(net, me)` instead. `displayNick(me)` returns
// the operator account name for users, which may DIFFER from the
// per-network IRC nick after NickServ ghost recovery (account "vjt",
// IRC nick "vjt-grappa") OR when the account name happens to match a
// peer's IRC nick on a network where the operator's configured nick
// is something else. Using `displayNick` as a per-network own-nick
// fallback was the codebase-review-2026-05-08 cic H3 silent root
// cause of DM-misrouting (server broadcasts on `channel:<peerNick>`
// which equals `channel:<accountName>`, cic subscribes to the wrong
// topic and re-keys messages to the wrong window).
export function displayNick(me: MeResponse): string {
  return me.kind === "user" ? me.name : me.nick;
}

// Per-network own IRC nick — the canonical answer to "which nick am I
// running as on this network". Single source for the wire-vs-account
// disambiguation.
//
// Resolution rules (post-bucket-F H4 type-split):
//   * visitor me + matching network_slug → `me.nick` (the visitor IS
//     the IRC nick — visitors have one network only).
//   * visitor me + other network         → `null` (visitors have no
//     credential row on networks they didn't log into).
//   * user me + UserNetwork              → `net.nick` (the per-credential
//     configured IRC nick, kept live by the `own_nick_changed`
//     user-topic event).
//   * user me + VisitorNetwork           → `null` (subject/network kind
//     mismatch — a visitor-shaped network row in a user's network list
//     is a server contract violation that the boundary fetcher in
//     `lib/networks.ts` should have rejected. We log + return null so
//     downstream callers skip the join rather than crash.)
//   * null me                            → `null`
//
// Use everywhere a per-network "own nick" comparison is made: the
// channels-loop self-JOIN/PART detection, the query-windows-loop
// own-nick skip, the DM-listener loop subscription topic, the
// ScrollbackPane self-highlight + mention-match.
//
// Pre-bucket-F the type was a single `Network` shape with all
// user-only fields optional, and the bottom branch checked
// `net.nick !== undefined && net.nick !== ""`. The discriminated
// union enforces this at the type system: `net.nick` is unreachable
// on `VisitorNetwork`, so the kind-mismatch branch is structurally
// distinct and the type narrowing is the documentation.
export function ownNickForNetwork(net: Network, me: MeResponse | null | undefined): string | null {
  if (me == null) return null;
  if (me.kind === "visitor") {
    return me.network_slug === net.slug ? me.nick : null;
  }
  if (net.kind === "user") return net.nick;
  console.error(
    `ownNickForNetwork: user subject but Network.kind=visitor for slug=${net.slug} — server contract violation (a visitor-shaped network row landed in a user's network list, which the boundary fetcher in lib/networks.ts should have rejected). Falling through to null; caller will skip topic join. See codebase review 2026-05-12 cic H4.`,
  );
  return null;
}

// Mirror of `Grappa.Networks.Wire.network_json/0` (visitor subject) +
// `network_with_nick_json/0` (user subject). The integer `id` is the
// Ecto FK; the `slug` is the topic-vocabulary identifier — every
// REST URL takes `:network_id` as the slug, not the integer id.
//
// Discriminated union over subject kind. The server renders TWO
// distinct JSON shapes (visitor: bare id+slug+timestamps; user: adds
// `nick` + the three T32 connection_state fields) but does NOT emit
// an explicit `kind` discriminator on the wire — the shape difference
// is implicit in the request authentication subject. Cic injects the
// `kind` field at the fetch boundary (`lib/networks.ts` resource) by
// joining each row against the subject from `me()`. This promotes the
// implicit-shape contract to a TypeScript-discriminated union so
// every consumer narrows via `network.kind === "user"` before
// touching the user-only fields — no scattered `?.connection_state ??`
// defensive checks downstream.
//
// Bucket F H4 fix: pre-fix the type was a single shape with all
// user-only fields marked `?:` optional. The optionality was correct
// for visitors but the type system couldn't enforce that
// `network.connection_state` was unreachable on the visitor branch —
// every consumer wrote `?.connection_state` "just in case" and the
// branches drifted (some sites checked, some didn't, none narrowed
// the type). Per CLAUDE.md "Consistency: same problem, same solution"
// this mirrors the user-vs-visitor `MeResponse` discriminated union
// that already lives at line 63 — the kind is the same domain
// boundary, the type system enforces it the same way.
export type UserNetwork = {
  kind: "user";
  id: number;
  slug: string;
  // The per-network IRC nick configured in the credential — REQUIRED
  // for user subjects per server contract. Pre-bucket-F this was
  // `nick?: string` and a missing-nick branch leaked through to
  // `ownNickForNetwork` which logged "server contract violation" and
  // returned null. The required-string typing here puts the
  // contract violation at the construction boundary
  // (`lib/networks.ts` resource fetch) instead of the consumption
  // boundary (every callsite that reads `.nick`).
  nick: string;
  // T32 connection-state fields — REQUIRED for user subjects. Default
  // for a freshly-bound credential is "connected". `failed` is a
  // server-set transition (admission failure / network unreachable);
  // `parked` is a user-initiated /disconnect.
  connection_state: CredentialConnectionState | "failed";
  connection_state_reason: string | null;
  connection_state_changed_at: string | null;
  inserted_at: string;
  updated_at: string;
};

export type VisitorNetwork = {
  kind: "visitor";
  id: number;
  slug: string;
  inserted_at: string;
  updated_at: string;
};

export type Network = UserNetwork | VisitorNetwork;

// Raw server wire shape for `GET /networks` — the JSON the server
// emits, BEFORE cic's boundary fetcher promotes each row to the
// `Network` discriminated union via `tagNetwork(raw)`. The wire
// shape carries an explicit `kind: "user" | "visitor"` discriminator
// (no-silent-drops B6.9a HIGH-24) so cic doesn't have to join against
// `me().kind` at the call site.
//
// `kind` is typed optional here so legacy fixtures + the rare older
// deployment that hasn't yet rolled forward still type-check;
// `tagNetwork` defaults a missing `kind` based on the presence of
// user-shape fields (`nick + connection_state`) — so the shape
// promotion stays robust mid-rollout. Once every deployed server
// emits `kind` explicitly, the optional marker can flip to required
// and the inference fallback can be removed.
export type RawNetwork = {
  kind?: "user" | "visitor";
  id: number;
  slug: string;
  nick?: string;
  connection_state?: CredentialConnectionState | "failed";
  connection_state_reason?: string | null;
  connection_state_changed_at?: string | null;
  inserted_at: string;
  updated_at: string;
};

// Boundary tagger — promotes a raw wire `RawNetwork` to a typed
// `Network` discriminated by the server-set `kind` field. Called in
// `lib/networks.ts`'s networks resource.
//
// On user subjects we assert nick + connection_state are present
// (server contract); a missing nick is logged + the row is dropped
// (returns null) so the caller filters before binding into the
// reactive store. Pre-fix the missing-nick branch leaked through to
// every `ownNickForNetwork` callsite which checked + logged
// individually.
//
// HIGH-24 (no-silent-drops B6.9a 2026-05-14): when `raw.kind` is
// absent (legacy fixture / older deployment), infer the discriminator
// from user-shape fields — a non-empty `nick` tags `user`, otherwise
// `visitor`. This is the rolling-deployment fallback; once every
// server emits `kind` explicitly the inference can be removed.
export function tagNetwork(raw: RawNetwork): Network | null {
  const kind = raw.kind ?? (raw.nick !== undefined && raw.nick !== "" ? "user" : "visitor");
  if (kind === "visitor") {
    return {
      kind: "visitor",
      id: raw.id,
      slug: raw.slug,
      inserted_at: raw.inserted_at,
      updated_at: raw.updated_at,
    };
  }
  if (raw.nick === undefined || raw.nick === "") {
    console.error(
      `tagNetwork: user subject but RawNetwork.nick missing for slug=${raw.slug} — server contract violation (network_with_nick_to_json should have populated it). Dropping the row from the typed networks list. See codebase review 2026-05-12 cic H4.`,
    );
    return null;
  }
  if (raw.connection_state === undefined) {
    console.error(
      `tagNetwork: user subject but RawNetwork.connection_state missing for slug=${raw.slug} — server contract violation. Dropping the row from the typed networks list.`,
    );
    return null;
  }
  return {
    kind: "user",
    id: raw.id,
    slug: raw.slug,
    nick: raw.nick,
    connection_state: raw.connection_state,
    connection_state_reason: raw.connection_state_reason ?? null,
    connection_state_changed_at: raw.connection_state_changed_at ?? null,
    inserted_at: raw.inserted_at,
    updated_at: raw.updated_at,
  };
}

// Mirror of `Grappa.Networks.Wire.channel_json/0` post-A5. Object envelope
// extended in P4-1 with the live `joined` state and the `source` of the
// list entry: `"autojoin"` (declared in the credential's autojoin_channels),
// `"joined"` (currently in session state.members but NOT in autojoin —
// dynamically joined post-boot via REST/IRC).
//
// Q3 of P4-1 cluster pinned the merge: when a channel is in BOTH sources,
// `:autojoin` wins (operator intent durable; session JOIN transient).
export type ChannelEntry = {
  name: string;
  joined: boolean;
  source: "autojoin" | "joined";
};

// Mirror of `Grappa.Scrollback.Wire.t/0` + the `:event` push wrapper
// emitted by `GrappaWeb.GrappaChannel`. The push event name on the wire
// is literally `"event"`; the `kind` field discriminates the inner
// payload shape so future kinds (presence, topic-change) can land
// without changing the channel push contract.
//
// The union mirrors `Grappa.Scrollback.Message.kind()` exhaustively
// (lib/grappa/scrollback/message.ex `@kinds`). Wire encoding is
// `Atom.to_string/1` via Jason — `:nick_change` serializes to
// `"nick_change"` (snake_case, NOT kebab). Phase 1 only WRITES `:privmsg`
// today; the rest are reserved for Phase 5 presence-event capture and
// the Phase 6 IRCv3 `CHATHISTORY` listener facade. Renderers MUST be
// exhaustive over this union — see `assertNever` in `ScrollbackPane`.
//
// no-silent-drops B6.11 (HIGH-7) — `server_event` joined the union
// for catch-all rows on `$server` (KILL, WALLOPS, GLOBOPS, ERROR,
// CHGHOST, vendor verbs). Pre-flip these arrived as
// `notice + meta.raw_verb`, indistinguishable from real CTCP/NickServ
// notices at the type level. ScrollbackPane's dispatcher now has a
// dedicated arm; the legacy `notice + raw_verb` arm stays as a
// fallback for any rows the cold-deploy backfill missed.
export type MessageKind =
  | "privmsg"
  | "notice"
  | "action"
  | "join"
  | "part"
  | "quit"
  | "nick_change"
  | "mode"
  | "topic"
  | "kick"
  | "server_event";

export type ScrollbackMessage = {
  id: number;
  network: string;
  channel: string;
  server_time: number;
  kind: MessageKind;
  sender: string;
  body: string | null;
  meta: Record<string, unknown>;
};

// Bucket G H3 (codebase-review-2026-05-12): canonical full union of
// per-channel WS events pushed by `GrappaWeb.GrappaChannel` on the
// per-channel topic (`grappa:user:{u}/network:{slug}/channel:{name}`).
// `kind` is the discriminator.
//
// Pre-bucket-G this type was duplicated between TWO sites with
// DIFFERENT breadth: `api.ts` declared a narrow `ChannelEvent = {kind:
// "message", message}` (one arm), and `subscribe.ts:96-124` redeclared
// the full 6-kind union as a local `WireEvent` type. A future consumer
// importing `ChannelEvent` from `api.ts` was type-blind to 5 of the 6
// kinds — the discriminator narrowing succeeded vacuously because the
// type knew only about `message`. The drift was a latent foot-gun:
// adding a new wire kind here didn't surface at any consumer that
// imported the narrow `api.ts` shape.
//
// Post-fix: single canonical `WireChannelEvent` union here mirrors
// `WireUserEvent` (line 381). All consumers import from this single
// site; `assertNever` exhaustiveness in switch handlers (subscribe.ts)
// catches new arms at `tsc` compile time. Pattern matches what bucket
// F's `Network` discriminated-union split achieved for the per-network
// boundary.
//
// `ChannelEvent` is retained as a legacy export aliased to the
// `message` arm so any in-tree caller that references the old name
// keeps working — it's the single arm that pre-fix consumers could
// validly narrow to. The rename to `WireChannelEvent` is the canonical
// import.
export type WireChannelEvent =
  | { kind: "message"; message: ScrollbackMessage }
  | { kind: "topic_changed"; network: string; channel: string; topic: TopicEntry }
  | { kind: "channel_modes_changed"; network: string; channel: string; modes: ModesEntry }
  | { kind: "channel_created"; network: string; channel: string; created_at: string }
  | { kind: "members_seeded"; network: string; channel: string; members: MemberEntry[] }
  // CP15 B5: typed window-state events. Server-side apply_effects arms
  // broadcast these on the per-channel topic; the snapshot push
  // (push_window_state_if_known) uses byte-identical payloads so cic
  // dispatches one handler arm regardless of origin path. `:parted` is
  // intentionally NOT broadcast — its projection is "key removed from
  // windowStateByChannel"; cic derives it from the existing :part
  // presence message when sender === ownNick.
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
    }
  // CP29 R-4: cross-device cursor sync. Server emits on every successful
  // `Grappa.ReadCursor.advance/4`; cic's `subscribe.ts` per-channel
  // handler routes through `readCursor.ts:applyReadCursorSet/3`. Forward-
  // only at the wire level (server only emits on advance), but the
  // applier guards against regression too. Plan O6.
  | {
      kind: "read_cursor_set";
      last_read_message_id: number;
    };
// P-0e + P-0f — invite_ack moved from per-channel topic to user-topic
// (operators usually invite peers to channels they are NOT in;
// per-channel routing silent-dropped in the common case). The arm
// now lives on `WireUserEvent` below.

// Legacy alias — narrow shape that pre-bucket-G consumers depended on.
// New code should import `WireChannelEvent` and narrow on `kind`.
export type ChannelEvent = Extract<WireChannelEvent, { kind: "message" }>;

// Mirror of `Grappa.QueryWindows.Wire.windows_entry/0` (CP15 B6).
// Each query-window has a `target_nick` + ISO-8601 `opened_at`. The
// server-side `windows_map` keys on integer `network_id`; on the wire
// JSON keys are strings (Object), see `parseWindowsMap` in
// `userTopic.ts` for the typed coercion.
export type QueryWindowEntry = {
  target_nick: string;
  opened_at: string;
};

// Per-message item in the `mentions_bundle` payload (Session.Wire
// `mentions_bundle_message/0`). Deliberately stripped vs
// `ScrollbackMessage`: no id/network/meta — the bundle is a
// cross-channel summary view that doesn't need persistence keys.
// `kind` is the same string projection of `Message.kind()`.
export type MentionsBundleMessage = {
  server_time: number;
  channel: string;
  sender_nick: string;
  body: string | null;
  kind: string;
};

// C2 — WHOIS bundle payload. Mirrors `Grappa.Session.Wire.whois_bundle/3`.
// Aggregated reply to `/whois <nick>` issued by the operator. Every
// upstream-derived field is nullable: a stripped-down upstream (or a
// non-existent target) may emit only 318 RPL_ENDOFWHOIS, in which case
// the bundle has only `target` populated and cic renders a "no such
// nick" surface. `channels` is the joined list with mode prefixes
// preserved (e.g. ["@#italia", "+#grappa"]).
export type WhoisBundle = {
  network: string;
  target: string;
  user: string | null;
  host: string | null;
  realname: string | null;
  server: string | null;
  server_info: string | null;
  is_operator: boolean;
  idle_seconds: number | null;
  signon: number | null;
  channels: string[] | null;
  // P-0a — Cluster `numeric-delegation-p0` 2026-05-13. Server emits typed
  // booleans / strings / integers; cic owns the human-readable rendering
  // ("Services Agent" / "is using SSL" / etc) per
  // `feedback_no_localized_strings_server_side`. Booleans default false
  // when the corresponding numeric did not fire; optional strings nil.
  using_ssl: boolean;
  is_registered: boolean;
  is_admin: boolean;
  is_services_admin: boolean;
  is_helper: boolean;
  is_chanop: boolean;
  is_agent: boolean;
  is_java: boolean;
  umodes: string | null;
  away_message: string | null;
  actually_host: string | null;
  actually_ip: string | null;
};

// P-0c — WHOWAS bundle payload. Mirrors `Grappa.Session.Wire.whowas_bundle/3`.
// Aggregated reply to `/whowas <nick>` issued by the operator. The
// most-recent historical entry is projected into the user/host/realname/
// server/logoff_time fields by the server. `not_found: true` is the 406
// ERR_WASNOSUCHNICK case — historical fields stay null and cic renders
// a "no history" surface. `logoff_time` ships as the upstream-supplied
// localized ctime string (server emits it verbatim — cic does NOT
// parse).
export type WhowasBundle = {
  network: string;
  target: string;
  user: string | null;
  host: string | null;
  realname: string | null;
  server: string | null;
  logoff_time: string | null;
  not_found: boolean;
};

// Mirror of the events fanned out on the user-level PubSub topic
// (`Topic.user(user_name)`), pinned by:
//   * `Grappa.Session.Wire.{channels_changed/0, own_nick_changed/2,
//      away_confirmed/2, mentions_bundle/5}` (CP16 B1)
//   * `Grappa.Networks.Wire.connection_state_changed_event/4`
//      (CP16 B3)
//   * `lib/grappa_web/channels/grappa_channel.ex` `query_windows_list`
//      pushed by the after-join + the Session's
//      `Grappa.QueryWindows.broadcast_after_change/1`.
//
// Pre-CP16 B5 `userTopic.ts` consumed payloads as `{kind?: string;
// [k: string]: unknown}` and narrowed via `as string` casts —
// adding a new server-side event kind produced no compile error;
// removing a field silently dropped at runtime. This discriminated
// union promotes the contract to compile-time enforcement: a new
// kind = a new arm here + a corresponding handler arm in
// `userTopic.ts`'s switch (caught by the trailing `assertNever`).
export type WireUserEvent =
  | { kind: "channels_changed" }
  | { kind: "query_windows_list"; windows: Record<string, QueryWindowEntry[]> }
  | {
      kind: "mentions_bundle";
      network: string;
      away_started_at: string;
      away_ended_at: string;
      away_reason: string | null;
      messages: MentionsBundleMessage[];
    }
  | { kind: "away_confirmed"; network: string; state: "present" | "away" }
  | { kind: "own_nick_changed"; network_id: number; nick: string }
  | {
      // CP17 — server-driven `:pending` window-state origination.
      // Server's `record_in_flight_join/2` emits this on `Topic.user/1`
      // (NOT per-channel — chicken-and-egg: cic only joins the
      // per-channel topic AFTER seeing :pending in
      // windowStateByChannel). userTopic.ts dispatches into
      // `setPending(channelKey(network, channel))`. Pre-CP17 cic
      // mutated the same store optimistically from compose.ts:210
      // — origination violation, now closed.
      kind: "window_pending";
      network: string;
      channel: string;
      state: "pending";
    }
  | {
      kind: "connection_state_changed";
      user_id: string;
      network_id: number;
      network_slug: string;
      from: string;
      to: string;
      reason: string | null;
      at: string | null;
    }
  | ({ kind: "whois_bundle" } & WhoisBundle)
  | {
      // P-0b — standalone 301 RPL_AWAY ephemeral. Fires when the
      // operator /msg's an away peer; cic dm-listener arm renders
      // an inline "(peer is away: <message>)" in the peer's DM
      // window. Server emits one event per upstream 301 — no
      // server-side dedup; display rate is a UI concern owned by
      // cic.
      kind: "peer_away";
      network: string;
      peer: string;
      message: string;
    }
  | {
      // P-0d — LUSERS bundle ephemeral. Fires on connect-welcome AND
      // on operator-issued /lusers; cic last-write-wins replaces the
      // per-network snapshot in lusersBundle.ts and renders the
      // LusersCard pinned at the top of the $server window.
      kind: "lusers_bundle";
      network: string;
      total_users: number | null;
      invisible: number | null;
      servers: number | null;
      operators: number | null;
      unknown_connections: number | null;
      channels_formed: number | null;
      local_clients: number | null;
      local_servers: number | null;
      current_local: number | null;
      max_local: number | null;
      current_global: number | null;
      max_global: number | null;
    }
  | ({ kind: "whowas_bundle" } & WhowasBundle)
  | {
      // P-0e + P-0f — 341 RPL_INVITING ack. Server broadcasts on
      // user-topic (P-0f flipped from per-channel; operators usually
      // invite peers to channels they are NOT in). cic appends a
      // synthetic ephemeral row to the per-network store keyed on
      // target channel, and `InviteAckRows` renders inline in the
      // $server window scrollback. NOT persisted — immediate-
      // feedback signal, not audit log.
      kind: "invite_ack";
      network: string;
      channel: string;
      peer: string;
    }
  | { kind: "bundle_hash"; hash: string };

// Exhaustiveness assertion for discriminated-union switches. If the
// switch handles every arm, the parameter type narrows to `never` at
// the default branch and `tsc` accepts the call. If a new arm is
// added without a handler, the parameter type widens away from
// `never` and `tsc` rejects — the build fails before the unhandled
// kind silently drops at runtime.
//
// Used by `userTopic.ts` for `WireUserEvent` and by `subscribe.ts`
// (cic M2) for `WireEvent`. Same pattern as `ScrollbackPane`'s
// exhaustive `MessageKind` switch (CP10 C3).
export function assertNever(x: never): never {
  throw new Error(`unreachable discriminated-union variant: ${JSON.stringify(x)}`);
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly info: Record<string, unknown>;

  constructor(status: number, code: string, info: Record<string, unknown> = {}) {
    super(`${status} ${code}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.info = info;
  }
}

// 401-handler registry. `auth.ts` registers a callback at module-load
// that clears the bearer + localStorage when ANY request comes back
// 401. This makes the api module the single chokepoint for "the
// server says this token is dead" — without it, `Plugs.Authn` 401s
// surface as `ApiError(401, "unauthorized")` to the calling component
// while the bearer stays in localStorage; the UI looks logged-in but
// every call fails silently. The dead-token detect propagates via the
// `token` signal: setToken(null) → socket.ts createEffect disconnects
// the WS, RequireAuth bounces to /login.
//
// Decoupled via a callback (not a direct `import { setToken } from
// "./auth"`) to avoid the auth ↔ api circular dependency. The handler
// is fire-and-forget; api never awaits it. Cleared back to null in
// tests via `setOn401Handler(null)` between cases.
//
// Login's own 401 ("invalid_credentials") triggers this too — but the
// pre-login token is null, so setToken(null) is a no-op. Logout's
// 401 already gets caught by `auth.logout`'s try/catch; the handler
// firing first just clears the same state twice. Both benign.
let on401Handler: (() => void) | null = null;

export function setOn401Handler(fn: (() => void) | null): void {
  on401Handler = fn;
}

async function readError(res: Response): Promise<ApiError> {
  if (res.status === 401 && on401Handler !== null) on401Handler();
  let body: Record<string, unknown> = {};
  let code: string;
  try {
    body = (await res.json()) as Record<string, unknown>;
    // Resolution order:
    //   1. `body.error` — the canonical A7 envelope shape used by every
    //      `FallbackController` arm (`{error: "<token>"}`), including
    //      the bucket-G-unified 422 `{error: "validation_failed",
    //      field_errors: ...}` shape. The whole body is captured into
    //      `info` so callers can read `err.info.field_errors`,
    //      `err.info.site_key`, etc. without a second round-trip.
    //   2. `body.errors.detail` — Phoenix's default `ErrorJSON` shape
    //      for 404/500/etc. (see `lib/grappa_web/controllers/error_json.ex`).
    //      Distinct from the post-bucket-G changeset path (`field_errors`)
    //      which routes through `body.error`.
    //   3. `res.statusText` — last-resort wire-shape fallback for
    //      pre-FallbackController paths or unrecognised body shapes.
    const errs = body.errors as { detail?: string } | undefined;
    code = (body.error as string | undefined) ?? errs?.detail ?? res.statusText;
  } catch {
    code = res.statusText || "unknown";
  }
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter !== null) {
    const n = Number(retryAfter);
    if (Number.isFinite(n)) body.retry_after = n;
  }
  return new ApiError(res.status, code, body);
}

export async function login(req: LoginRequest): Promise<LoginResponse> {
  const res = await fetch("/auth/login", {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(req),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as LoginResponse;
}

export async function me(token: string): Promise<MeResponse> {
  const res = await fetch("/me", {
    headers: buildHeaders(token),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as MeResponse;
}

export async function logout(token: string): Promise<void> {
  const res = await fetch("/auth/logout", {
    method: "DELETE",
    headers: buildHeaders(token),
  });
  if (!res.ok) throw await readError(res);
}

export async function listNetworks(token: string): Promise<RawNetwork[]> {
  const res = await fetch("/networks", {
    headers: buildHeaders(token),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as RawNetwork[];
}

export async function listChannels(token: string, networkSlug: string): Promise<ChannelEntry[]> {
  const res = await fetch(`/networks/${encodeURIComponent(networkSlug)}/channels`, {
    headers: buildHeaders(token),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as ChannelEntry[];
}

// Mirror of `GrappaWeb.MessagesController.index/2`. Returns rows DESC by
// (server_time, id) — newest first. The server emits a flat array, not a
// `{messages, next_cursor}` envelope; the cursor is the `id` of the
// oldest row in the page (callers feed it back as `?before=<id>`).
// Empty page = no more history.
//
// Cursor semantics flipped from server_time → id in CP29 R-2 to
// eliminate same-millisecond ties straddling page boundaries.
export async function listMessages(
  token: string,
  networkSlug: string,
  channelName: string,
  before?: number,
): Promise<ScrollbackMessage[]> {
  const qs = before === undefined ? "" : `?before=${before}`;
  const res = await fetch(
    `/networks/${encodeURIComponent(networkSlug)}/channels/${encodeURIComponent(channelName)}/messages${qs}`,
    { headers: buildHeaders(token) },
  );
  if (!res.ok) throw await readError(res);
  return (await res.json()) as ScrollbackMessage[];
}

// Sole consumer (today): the WS-reconnect refresh flow in
// `lib/scrollback.ts:refreshScrollback`. After a Phoenix Channel
// re-join, cic asks the server "give me every row whose id is greater
// than the resume cursor" — closes the live-stream gap caused by best-
// effort PubSub fan-out on a transiently-disconnected WS.
//
// Mirror of `GrappaWeb.MessagesController.index/2`'s `?after=<id>`
// path. Server returns rows in ASC `id` order (chronological), so
// callers append to the existing scrollback tail directly. `limit` is
// optional; when omitted the server defaults to its own `@default_limit`
// (50). The R-5 caller passes 200 (the server's `@max_http_limit`) so
// a long disconnect can recover in a single round-trip.
export async function listMessagesAfter(
  token: string,
  networkSlug: string,
  channelName: string,
  afterId: number,
  limit?: number,
): Promise<ScrollbackMessage[]> {
  const limitQs = limit === undefined ? "" : `&limit=${limit}`;
  const res = await fetch(
    `/networks/${encodeURIComponent(networkSlug)}/channels/${encodeURIComponent(channelName)}/messages?after=${afterId}${limitQs}`,
    { headers: buildHeaders(token) },
  );
  if (!res.ok) throw await readError(res);
  return (await res.json()) as ScrollbackMessage[];
}

// Mirror of `GrappaWeb.MessagesController.create/2`. Server hardcodes
// `kind = :privmsg` — only `body` is in the request envelope. Returns
// 201 + the persisted Wire row; the same row also fires on the
// per-channel PubSub topic, so a connected client receives it via WS
// push and the store's existing event handler appends it to scrollback.
// The REST response is the secondary confirmation, not the primary
// surface for the new row.
export async function sendMessage(
  token: string,
  networkSlug: string,
  channelName: string,
  body: string,
): Promise<ScrollbackMessage> {
  const res = await fetch(
    `/networks/${encodeURIComponent(networkSlug)}/channels/${encodeURIComponent(channelName)}/messages`,
    {
      method: "POST",
      headers: buildHeaders(token),
      body: JSON.stringify({ body }),
    },
  );
  if (!res.ok) throw await readError(res);
  return (await res.json()) as ScrollbackMessage;
}

// Mirror of `GrappaWeb.ChannelsController.topic/2`. Sets the topic on
// `channelName` for the operator's session on `networkSlug`. Server emits
// a `:topic` scrollback row that the WS push delivers; we don't read the
// 202 body (it's `{ok: true}`).
export async function postTopic(
  token: string,
  networkSlug: string,
  channelName: string,
  body: string,
): Promise<void> {
  const res = await fetch(
    `/networks/${encodeURIComponent(networkSlug)}/channels/${encodeURIComponent(channelName)}/topic`,
    {
      method: "POST",
      headers: buildHeaders(token),
      body: JSON.stringify({ body }),
    },
  );
  if (!res.ok) throw await readError(res);
}

// Mirror of `GrappaWeb.ChannelsController.create/2`. POST a channel
// name; the server forwards a JOIN to the upstream session. The 202
// envelope is `{ok: true}` — we don't read the body.
export async function postJoin(
  token: string,
  networkSlug: string,
  channelName: string,
): Promise<void> {
  const res = await fetch(`/networks/${encodeURIComponent(networkSlug)}/channels`, {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify({ name: channelName }),
  });
  if (!res.ok) throw await readError(res);
}

// Mirror of `GrappaWeb.ChannelsController.delete/2`. DELETE the channel
// to forward a PART upstream. Server emits a `:part` scrollback row +
// the EventRouter Map.deletes the channel key from state.members.
export async function postPart(
  token: string,
  networkSlug: string,
  channelName: string,
): Promise<void> {
  const res = await fetch(
    `/networks/${encodeURIComponent(networkSlug)}/channels/${encodeURIComponent(channelName)}`,
    {
      method: "DELETE",
      headers: buildHeaders(token),
    },
  );
  if (!res.ok) throw await readError(res);
}

// Mirror of `GrappaWeb.ArchiveJSON.index/1` (CP15 B4) — wire shape:
//   { "archive": [{"target", "kind", "last_activity", "row_count"}] }
// Server-side `Scrollback.list_archive/3` already sorts by
// `last_activity` DESC and excludes the active keyset (joined channels +
// open query windows) + the `$server` pseudo-channel. The unwrap below
// returns the inner array; the envelope is a stylistic mirror of
// MembersJSON's `{"members": [...]}` shape.
export type ArchiveEntry = {
  target: string;
  kind: "channel" | "query";
  last_activity: number;
  row_count: number;
};

export async function listArchive(token: string, networkSlug: string): Promise<ArchiveEntry[]> {
  const res = await fetch(`/networks/${encodeURIComponent(networkSlug)}/archive`, {
    headers: buildHeaders(token),
  });
  if (!res.ok) throw await readError(res);
  const body = (await res.json()) as { archive: ArchiveEntry[] };
  return body.archive;
}

// Mirror of `GrappaWeb.NickController.create/2`. Sends `NICK <new>`
// upstream through the session. The upstream replays the NICK back via
// `EventRouter`'s NICK handler which fans out per-channel `:nick_change`
// scrollback rows + reconciles `state.nick` server-side.
export async function postNick(token: string, networkSlug: string, nick: string): Promise<void> {
  const res = await fetch(`/networks/${encodeURIComponent(networkSlug)}/nick`, {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify({ nick }),
  });
  if (!res.ok) throw await readError(res);
}

// Mirror of `GrappaWeb.NetworksController.update/2` (T32).
// PATCH `/networks/:network_id` — transitions the credential's
// `connection_state` to `:parked` (user-initiated disconnect) or
// `:connected` (re-connect + respawn). `:failed` is server-set only
// and is rejected by the endpoint (400) — do not send it.
//
// Accepts `{connection_state: "parked"|"connected", reason?: string}`.
// Returns the updated `credential_json` shape (including the three new
// T32 fields: `connection_state`, `connection_state_reason`,
// `connection_state_changed_at`) — mirror of `Wire.credential_to_json/1`.
//
// `reason` propagates to the server-lifecycle event and to the
// `connection_state_reason` column, surfacing in the server-messages
// window (#4) and in the credential badge rendering.
export type CredentialConnectionState = "connected" | "parked";

export type CredentialJson = {
  network: string;
  nick: string;
  realname: string | null;
  sasl_user: string | null;
  auth_method: string;
  auth_command_template: string | null;
  autojoin_channels: string[];
  connection_state: CredentialConnectionState | "failed";
  connection_state_reason: string | null;
  connection_state_changed_at: string | null;
  inserted_at: string;
  updated_at: string;
};

export async function patchNetwork(
  token: string,
  networkSlug: string,
  body: { connection_state: CredentialConnectionState; reason?: string },
): Promise<CredentialJson> {
  const res = await fetch(`/networks/${encodeURIComponent(networkSlug)}`, {
    method: "PATCH",
    headers: buildHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as CredentialJson;
}
