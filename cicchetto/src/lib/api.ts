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
  | { error: "connect_timeout" }
  | { error: "welcome_timeout" }
  | { error: "probe_timeout" }
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
  // #126 — `registered` = NickServ identity present (server-derived from
  // password_encrypted). The cic gate for the persistent-identity verbs:
  // a registered visitor gets detach + disconnect/reconnect + quit, an
  // ephemeral (`registered !== true`) visitor gets only quit. Optional so
  // a localStorage subject persisted BEFORE this field landed still
  // validates (treated as not-registered until the next login refreshes
  // it); fresh logins always carry it.
  | { kind: "visitor"; id: string; nick: string; network_slug: string; registered?: boolean };

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
// id}}`). Hydrated once at login by `readCursor.ts`'s
// `applyMeEnvelope/1`. Empty `{}` for a fresh subject. Optional in the
// type so test mocks predating R-3 don't have to be touched — production
// /me always emits it (server-side `MeJSON.show/1` puts it on the
// envelope unconditionally).
export type ReadCursorsEnvelope = Record<string, Record<string, number>>;

// Bucket C (2026-06-01) — `/me` `unread_counts` envelope. Nested
// `%{slug => %{chan => {messages, events}}}` mirror of `read_cursors`,
// keyed only for channels the subject already has a cursor on (no
// cursor = absent; cic falls back to the per-channel join reply seed
// from bucket B1). cic consumes via `networks.ts`'s `/me` resource
// arm: after `applyMeEnvelope(m.read_cursors)`, `applySeedEnvelope(
// m.unread_counts)` populates `selection.ts`'s `serverSeedCounts`
// signal so cold-load sidebar badges render the right messages/events
// split for never-focused channels. Optional in the type for the same
// reason `read_cursors` is — older test mocks may omit it; production
// /me always emits it.
export type UnreadCountsEnvelope = Record<
  string,
  Record<string, { messages: number; events: number }>
>;

// REV-H H2 (2026-05-22) — closed enumeration of upstream IRC
// connection states. Mirror of server-side
// `Grappa.Networks.Credential.connection_state()` atom union
// (encoded over JSON as the string discriminator); the server
// guards every transition through `Networks.connect/1`,
// `Networks.disconnect/2`, `Networks.mark_failed/2` so a fourth
// arm requires a server-side schema change AND this type update
// in lockstep. Single source of truth for every cic consumer:
// `HomeNetworkRow`, `CredentialJson`, `narrowUserEvent`'s
// `connection_state_changed` arm, and the per-network sidebar
// badge rendering.
export type ConnectionState = "connected" | "parked" | "failed";

// UX-4 bucket B — one row in the `home_data.networks` array, returned
// from `GET /me` for user subjects. Mirror of server-side
// `Grappa.Networks.Wire.home_network_row/0`. Identical shape to the
// `:network` field of `connection_state_changed` typed events
// (REV-J M15 folded the prior `home_network_state_changed` arm into
// that payload) so HomePane can patch slots in-place from live updates
// without re-derivation.
//
// Strict subset of `UserNetwork` (no `id`, no `kind`, no timestamps):
// the home pane is a UI view, not a network mirror. cic's
// `HomePaneRegistered` reads ONLY these fields.
export type HomeNetworkRow = {
  slug: string;
  nick: string;
  connection_state: ConnectionState;
  connection_state_reason: string | null;
  connection_state_changed_at: string | null;
};

// UX-4 bucket B — `home_data` envelope. Nested under `:networks` (NOT
// flat) so future home cards (`home_data.pinned`,
// `home_data.mentions_summary`, etc.) land as sibling keys without
// touching every caller.
export type HomeData = { networks: HomeNetworkRow[] };

export type MeResponse =
  | {
      kind: "user";
      id: string;
      name: string;
      // M-cluster M-7 — admin gate. Server emits this on every user
      // /me via `MeJSON.show/1` → `Accounts.Wire.user_to_json/1`
      // (lib/grappa_web/controllers/me_json.ex:41). Required: every
      // User row carries the boolean (default false at schema). Cic
      // gates the SettingsDrawer "admin console" entry off this bit;
      // see Shell.tsx adminOpen lifecycle for the demote-mid-session
      // refetch policy. Disjoint from `WhoisBundle.is_admin` (peer's
      // IRC privileges from upstream WHOIS) — different domain, same
      // field name, kept structurally separate via discriminated
      // unions on different types. UX-4 bucket N: AdminPane mount is
      // now driven by `selectedChannel().kind === "admin"` (no
      // separate `adminOpen` signal); demote handling lives in
      // Shell.tsx's redirect-on-demote createEffect.
      is_admin: boolean;
      inserted_at: string;
      read_cursors?: ReadCursorsEnvelope;
      // Bucket C (2026-06-01) — `/me` unread_counts envelope. See
      // `UnreadCountsEnvelope` typedoc above. Optional for the same
      // reason `read_cursors` is.
      unread_counts?: UnreadCountsEnvelope;
      // PWA icon badge door #2 (2026-06-21) — notify-worthy unread total
      // (`Grappa.Push.BadgeCount.count/1`), 0..99. Seeds the badge signal
      // at login. Optional for the same test-mock reason as the envelopes.
      badge_count?: number;
      // UX-4 bucket B — required for user subjects (server's
      // `MeJSON.show/1` user clause sets it unconditionally). Optional
      // on the type so test mocks predating the field landing don't
      // need touching — production /me always emits it.
      home_data?: HomeData;
    }
  | {
      kind: "visitor";
      id: string;
      nick: string;
      network_slug: string;
      expires_at: string;
      // #126 — `registered` = NickServ identity present (the detach /
      // disconnect gate); `connected` = whereis-derived live upstream
      // (drives the SettingsDrawer disconnect ⇄ reconnect toggle). Both
      // optional so test mocks predating the fields don't need touching;
      // production /me always emits them.
      registered?: boolean;
      connected?: boolean;
      read_cursors?: ReadCursorsEnvelope;
      // Bucket C (2026-06-01) — visitors get the same envelope shape;
      // empty `{}` for a fresh visitor (no cursors yet).
      unread_counts?: UnreadCountsEnvelope;
      // PWA icon badge door #2 (2026-06-21) — visitors get the same
      // scalar; seeds the badge signal at login.
      badge_count?: number;
      // UX-4 bucket B — visitor home is cic-only help text by design.
      // Server's `MeJSON.show/1` visitor clause sets `home_data: nil`
      // unconditionally. Optional + literal-null narrows the
      // discriminator: presence-with-`null` is the visitor signal,
      // presence-with-`{networks: [...]}` is the registered signal.
      home_data?: null;
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
  connection_state: ConnectionState;
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
  connection_state?: ConnectionState;
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

// Mirror of `GrappaWeb.DirectoryController.index/2` wire shape.
// `status` indicates the staleness of the captured list; `captured_at` is
// null when no list has been captured yet (status "empty"). `next_cursor`
// is null on the final page.
// `featured` (#85) is true when the channel is in its network's
// enabled `network_featured_channels` set — re-derived server-side on
// every directory fetch (on-display freshness). No top-pinning; the
// sort order is unchanged.
export type DirectoryEntry = {
  name: string;
  topic: string | null;
  user_count: number;
  featured: boolean;
};

export type DirectoryStatus = "fresh" | "stale" | "refreshing" | "empty";

export type DirectoryPage = {
  entries: DirectoryEntry[];
  next_cursor: string | null;
  total: number;
  captured_at: string | null;
  status: DirectoryStatus;
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

// Kind class for the unread-badge memo derivation (2026-06-01,
// unread-badges-from-cursor cluster). Content kinds are the "real
// messages" the operator wants the bold sidebar/bottom-bar badge for;
// presence kinds are the dimmer indicator. The classifier is
// single-sourced here so the in-pane unread marker, the sidebar memo,
// and the bottom-bar memo all share one definition — pre-cluster the
// predicate was duplicated inline at `subscribe.ts:231` and again at
// ScrollbackPane's in-pane marker filter.
export const CONTENT_KINDS: ReadonlySet<MessageKind> = new Set<MessageKind>([
  "privmsg",
  "notice",
  "action",
]);

export const isContentKind = (k: MessageKind): boolean => CONTENT_KINDS.has(k);
export const isPresenceKind = (k: MessageKind): boolean => !CONTENT_KINDS.has(k);

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
  // UX-5 BJ (2026-05-19) — recognized-but-ignored. Pre-BJ the JoinBanner
  // consumed this via `seedChannelCreated` for the "Channel was created
  // on …" line. BJ killed the banner; the server still emits the 329
  // RPL_CREATIONTIME broadcast (server-side reaping would be a separate
  // bucket). Keep the union arm so `narrowChannelEvent` recognizes the
  // payload and `subscribe.ts` can no-op explicitly instead of routing
  // every JOIN through `console.warn("dropped malformed payload")`.
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
  // applier guards against regression too.
  | {
      kind: "read_cursor_set";
      last_read_message_id: number;
      // PWA icon badge door #3 (2026-06-21) — notify-worthy unread total
      // AFTER this cursor advance. Reading anywhere refreshes every live
      // client's icon badge / document.title without a `/me` round-trip.
      badge_count: number;
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
  sender: string;
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

// #140 — /names roster bundle payload. Mirrors
// `Grappa.Session.Wire.names_reply/3`. Ephemeral reply to `/names
// [#chan]`: the server buffers the 353/366 burst and emits ONE typed
// event with the full roster (same `MemberEntry` shape as
// `members_seeded`, the authoritative sidebar set — this is a parallel
// VIEW). cic renders a grouped, scrollable, dismissable modal; clicking
// a nick opens a query. NOT persisted to scrollback.
export type NamesReply = {
  network: string;
  channel: string;
  members: MemberEntry[];
};

// #169 — one parsed 352 RPL_WHOREPLY row for the /who modal. Mirrors
// `Grappa.Session.Wire.who_user/1`. A SUPERSET of `MemberEntry` (adds
// user/host/server/hops/realname/channel). `modes` is the raw WHO flags
// STRING (e.g. "H@" = here + op), NOT the MemberEntry prefix-list — the
// modal renders it verbatim. `hops`/`realname` are null when the server
// omits the trailing field. WHOX (354) is not handled; the shape leaves
// room for a future handler to add account etc.
export type WhoUser = {
  nick: string;
  user: string;
  host: string;
  server: string;
  modes: string;
  hops: number | null;
  realname: string | null;
  channel: string;
};

// #169 — /who roster bundle payload. Mirrors
// `Grappa.Session.Wire.who_reply/3`. Ephemeral reply to `/who <#chan|nick>`:
// the server folds the 352 burst and drains on 315 into ONE typed event
// with the parsed per-user rows. cic renders a dismissable per-user table
// (WhoModal); clicking a nick opens a query. NOT persisted to scrollback.
export type WhoReply = {
  network: string;
  target: string;
  users: WhoUser[];
};

// #127 — /info, /version, /motd reply bundle. Mirrors
// `Grappa.Session.Wire.server_reply/3`. Ephemeral reply to an explicit
// `/info` (371/374), `/version` (351) or `/motd` (375/372/376/422): the
// server folds the reply burst and drains ONE typed event with the raw
// lines + a typed `source`. cic maps `source` to a human title (the server
// emits no display strings) and renders a dismissable scrollable retro
// modal (ServerReplyModal). NOT persisted; connect-time MOTD is unaffected
// (it stays on the $server window). `source` mirrors
// `SessionWireServerReplySource`.
export type ServerReplySource = "info" | "version" | "motd";
export type ServerReply = {
  network: string;
  source: ServerReplySource;
  lines: string[];
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
      // #78 — inbound INVITE to a not-joined channel. Server's
      // apply_effects([{:invited, ch}]) emits this on `Topic.user/1`
      // (same chicken-and-egg user-topic origination as window_pending:
      // cic only joins the per-channel topic AFTER seeing the state in
      // windowStateByChannel). userTopic.ts dispatches into
      // `setInvited(channelKey(network, channel))`; subscribe.ts's
      // pre-subscribe loop then joins the per-channel topic so the
      // persisted INVITE row lands in the channel buffer with [Join].
      kind: "window_invited";
      network: string;
      channel: string;
      state: "invited";
    }
  | {
      kind: "connection_state_changed";
      user_id: string;
      network_id: number;
      network_slug: string;
      from: ConnectionState;
      to: ConnectionState;
      reason: string | null;
      at: string | null;
      // REV-J M15: the prior standalone `home_network_state_changed`
      // arm folded into this payload as the `:network` field. HomePane
      // patches its row from this; Sidebar / query-window store keep
      // reading the wider top-level fields. One logical event, one wire
      // payload, one broadcast.
      network: HomeNetworkRow;
    }
  | ({ kind: "whois_bundle" } & WhoisBundle)
  | ({ kind: "names_reply" } & NamesReply)
  | ({ kind: "who_reply" } & WhoReply)
  | ({ kind: "server_reply" } & ServerReply)
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
      // target channel; ScrollbackPane's `rows()` memo interleaves it
      // into the $server window timeline by wallclock `at` so it
      // settles at its arrival position alongside server-message
      // arrivals (pre-2026-06-01 the prior sibling component pinned
      // acks to the bottom regardless of subsequent server messages —
      // vjt prod report). NOT persisted — immediate-feedback signal,
      // not audit log.
      kind: "invite_ack";
      network: string;
      channel: string;
      peer: string;
    }
  // F1 (visitor-parity-and-nickserv cluster, 2026-05-15) — typed
  // window-state terminal events dual-broadcast on `Topic.user/1`
  // alongside the per-channel topic. Server-side
  // `Session.Server.broadcast_window_state_dual/3` closes the
  // subscribe-then-broadcast race where a fast `pending → terminal`
  // transition fires the per-channel broadcast BEFORE cic's phx.join
  // handler is registered (Phoenix PubSub no-replay). User-topic is
  // joined at cic boot so it cannot race a subscribe — guaranteed
  // delivery. Same wire shape as the per-channel arms above; cic's
  // `userTopic.ts` dispatch routes them to the same
  // `setJoined/setFailed/setKicked` setters which are last-write-wins
  // idempotent.
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
  | { kind: "bundle_hash"; hash: string }
  // UX-6-B2 (2026-05-21) — operator-visible server-settings reactive
  // signal. Fired on `Admin.SettingsController.update/2` fan-out AND
  // on after-join snapshot from `GrappaChannel.push_server_settings/1`
  // (parity with `bundle_hash`). Wire shape mirrors
  // `Grappa.ServerSettings.Wire.server_settings_changed/1` (atoms-out).
  | {
      kind: "server_settings_changed";
      upload: {
        active_host: "embedded" | "litterbox";
        image_per_file_cap_bytes: number;
        video_per_file_cap_bytes: number;
        document_per_file_cap_bytes: number;
        audio_per_file_cap_bytes: number;
        global_cap_bytes: number;
      };
    }
  | { kind: "archive_changed"; network_slug: string }
  // UX-7-B (2026-05-22) — `archive_purged` push after a destructive
  // archive-entry delete (operator dropped scrollback for the target).
  // Distinct from `archive_changed` (which is refresh-only for the
  // archive LIST shape, e.g. PART moving a channel into archive): this
  // event ALSO invalidates the in-memory `scrollbackByChannel[key]` for
  // the target so cic doesn't ghost the pre-delete rows on re-JOIN. See
  // `Wire.archive_purged_payload/2` moduledoc for the bug history.
  | { kind: "archive_purged"; network_slug: string; target: string }
  // Channel-directory `/list` refresh progress pings (Topic.user). The
  // store (channelDirectory.ts) re-GETs the current directory view on
  // each; payload shapes mirror Grappa.Session.Wire.directory_{progress,
  // complete,failed}/2 (generated SessionWireDirectory*Payload in
  // wireTypes.ts).
  | { kind: "directory_progress"; network: string; count: number }
  | { kind: "directory_complete"; network: string; total: number }
  | { kind: "directory_failed"; network: string; reason: string };

// M-11 — Admin events stream. Discriminated union mirrors
// `Grappa.AdminEvents.Wire`'s closed `event_kind` enum. Server emits
// structured data only (atoms-as-strings, integers, ISO timestamps,
// typed enums); cic owns every localized string (renderer lives in
// `AdminEventsTab.tsx` `renderEvent`). Adding a new kind here that
// isn't dispatched in `adminEvents.ts` trips `tsc` via `assertNever`
// — same closed-union enforcement pattern as `WireUserEvent`.
//
// Lives outside `WireUserEvent` because the admin events ride on a
// distinct topic (`grappa:admin:events`) with its own authz gate
// (`is_admin: true`); folding onto WireUserEvent would tie the admin
// stream to the per-user routing.
// REV-A C2 — closed union mirroring server-side `Grappa.Admission.flow/0`
// (lib/grappa/admission.ex:53-58). Pre-REV-A this surface lived inline on
// the `capacity_reject` arm as `"user" | "visitor"` — a type lie: server
// emits the bare atom verbatim (Jason stringifies → 5 possible string
// values) so cic was tsc-blind to 3 of 5. A 5-arm regression pin lives
// in `__tests__/api.test.ts` to fail loudly if server's `flow/0` grows
// a 6th arm.
export type AdmissionFlow =
  | "login_fresh"
  | "login_existing"
  | "bootstrap_user"
  | "bootstrap_visitor"
  | "patch_network_connect";

export type WireAdminEvent =
  | {
      kind: "circuit_open";
      network_id: number;
      network_slug: string | null;
      threshold: number;
      cooldown_ms: number;
      at: string;
    }
  | {
      kind: "circuit_close";
      network_id: number;
      network_slug: string | null;
      reason: "success" | "cooldown_expired";
      at: string;
    }
  | {
      kind: "capacity_reject";
      flow: AdmissionFlow;
      error: string;
      network_id: number;
      network_slug: string | null;
      source_ip: string | null;
      at: string;
    }
  | {
      kind: "visitor_deleted";
      visitor_id: string;
      visitor_nick: string | null;
      network_slug: string | null;
      actor_user_id: string | null;
      actor_user_name: string | null;
      at: string;
    }
  | {
      kind: "visitor_reaped";
      visitor_id: string;
      visitor_nick: string | null;
      network_slug: string | null;
      at: string;
    }
  | { kind: "reaper_swept"; count: number; at: string }
  // REV-A C1 — per-upload reap event. Mirror of
  // `Grappa.AdminEvents.Wire.upload_reaped/4` (wire.ex:113-127). Emitted
  // by `Grappa.Uploads.Reaper` on every TTL-expired upload row. Pre-REV-A
  // this kind was missing from the cic union; an upload sweep crashed
  // `ingest()` via `assertNever` (every TTL tick on a deployment with
  // active uploads).
  | {
      kind: "upload_reaped";
      upload_id: string;
      slug: string;
      subject_kind: "user" | "visitor";
      subject_id: string;
      at: string;
    }
  // REV-A C1 — end-of-sweep summary. Mirror of
  // `Grappa.AdminEvents.Wire.uploads_swept/1` (wire.ex:122-126). Fires
  // once per non-empty Reaper tick + every operator-triggered sweep.
  | { kind: "uploads_swept"; count: number; at: string }
  | {
      kind: "session_disconnected";
      subject_kind: "user" | "visitor";
      subject_id: string;
      network_id: number;
      network_slug: string | null;
      actor_user_id: string | null;
      actor_user_name: string | null;
      at: string;
    }
  | {
      kind: "session_terminated";
      subject_kind: "user" | "visitor";
      subject_id: string;
      network_id: number;
      network_slug: string | null;
      actor_user_id: string | null;
      actor_user_name: string | null;
      at: string;
    }
  | {
      kind: "network_caps_updated";
      network_id: number;
      network_slug: string;
      max_concurrent_visitor_sessions: number | null;
      max_concurrent_user_sessions: number | null;
      max_per_ip: number | null;
      actor_user_id: string | null;
      actor_user_name: string | null;
      at: string;
    }
  | {
      kind: "circuit_reset";
      network_id: number;
      network_slug: string | null;
      actor_user_id: string | null;
      actor_user_name: string | null;
      at: string;
    }
  | {
      // REV-H H5 (2026-05-22): `network_slug` tightened to non-null.
      // The server-side broadcaster (`AdminEvents.broadcast_lifecycle/3`)
      // early-returns when `Networks.get_network/1` returns nil, so
      // this event NEVER fires with a missing slug. Other admin events
      // (circuit_open / capacity_reject / session_terminated) keep
      // their nullable `network_slug` because the deleted-network race
      // CAN reach those paths.
      kind: "cap_counts_changed";
      network_id: number;
      network_slug: string;
      visitors: number;
      users: number;
      max_concurrent_visitor_sessions: number | null;
      max_concurrent_user_sessions: number | null;
      at: string;
    }
  // ----- Admin-panel bucket 4 mutation events ----------------------
  //
  // Operator-initiated CRUD on users / networks / servers /
  // credentials. All carry non-null actor (admin gate guarantees a
  // logged-in operator at the controller). Wire shapes mirror
  // `lib/grappa/admin_events/wire.ex` constructors.
  | {
      kind: "user_created";
      user_id: string;
      user_name: string;
      is_admin: boolean;
      actor_user_id: string;
      actor_user_name: string;
      at: string;
    }
  | {
      kind: "user_updated";
      user_id: string;
      user_name: string;
      is_admin: boolean;
      actor_user_id: string;
      actor_user_name: string;
      at: string;
    }
  | {
      kind: "user_password_changed";
      user_id: string;
      user_name: string;
      actor_user_id: string;
      actor_user_name: string;
      at: string;
    }
  | {
      kind: "user_deleted";
      user_id: string;
      user_name: string;
      actor_user_id: string;
      actor_user_name: string;
      at: string;
    }
  | {
      kind: "network_created";
      network_id: number;
      network_slug: string;
      actor_user_id: string;
      actor_user_name: string;
      at: string;
    }
  | {
      kind: "network_deleted";
      network_id: number;
      network_slug: string;
      actor_user_id: string;
      actor_user_name: string;
      at: string;
    }
  | {
      kind: "server_added";
      network_id: number;
      network_slug: string;
      server_id: number;
      host: string;
      port: number;
      tls: boolean;
      actor_user_id: string;
      actor_user_name: string;
      at: string;
    }
  | {
      kind: "server_updated";
      network_id: number;
      network_slug: string;
      server_id: number;
      host: string;
      port: number;
      tls: boolean;
      actor_user_id: string;
      actor_user_name: string;
      at: string;
    }
  | {
      kind: "server_removed";
      network_id: number;
      network_slug: string;
      server_id: number;
      host: string;
      port: number;
      actor_user_id: string;
      actor_user_name: string;
      at: string;
    }
  | {
      kind: "credential_bound";
      user_id: string;
      user_name: string;
      network_id: number;
      network_slug: string;
      nick: string;
      actor_user_id: string;
      actor_user_name: string;
      at: string;
    }
  | {
      kind: "credential_updated";
      user_id: string;
      user_name: string;
      network_id: number;
      network_slug: string;
      session_action: "left_alone" | "stopped";
      actor_user_id: string;
      actor_user_name: string;
      at: string;
    }
  | {
      kind: "credential_unbound";
      user_id: string;
      user_name: string;
      network_id: number;
      network_slug: string;
      actor_user_id: string;
      actor_user_name: string;
      at: string;
    };

export type AdminSnapshotPayload = { events: WireAdminEvent[] };

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

// REV-K M20 (2026-05-22) — typed WS Channel push error mirroring
// `ApiError`. The Channel error envelope is `{:error, %{error: "<token>"}}`
// — same `error:` key as the REST `FallbackController` shape — so cic
// has one envelope to extract from. `code` carries the wire token
// (`"invalid_channel"`, `"upstream_unavailable"`, etc.); `info` captures
// the full server reply so callers can read sibling fields.
//
// Branching on `code` is the FUTURE consumer pattern (mirroring
// `friendlyApiError(e: ApiError)` for REST); current consumers
// (compose.ts) fall through to a generic "send failed" string. The
// typed class is the SHAPE that enables future branching without
// re-touching the push helpers — keeping the unification at the
// boundary where the envelope is decoded.
//
// Use `channelPushError/1` at `.receive("error", ...)` to convert the
// opaque `unknown` reply into a typed `Error` for the rejecting
// promise.
export class ChannelPushError extends Error {
  readonly code: string;
  readonly info: Record<string, unknown>;

  constructor(code: string, info: Record<string, unknown> = {}) {
    super(`channel push error: ${code}`);
    this.name = "ChannelPushError";
    this.code = code;
    this.info = info;
  }
}

export function channelPushError(raw: unknown): ChannelPushError {
  if (typeof raw !== "object" || raw === null) {
    return new ChannelPushError(String(raw));
  }
  const r = raw as Record<string, unknown>;
  const code = typeof r.error === "string" ? r.error : String(raw);
  return new ChannelPushError(code, r);
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

// M-cluster M-8 — admin Visitors tab wire types + fetch wrappers.
// Mirror of `Grappa.Visitors.AdminWire.t()`
// (lib/grappa/visitors/admin_wire.ex). `live_state === null` is the
// U-0 honesty signal: DB intent says active, BEAM has no pid for
// `{:visitor, id} × network.id`. The Visitors tab surfaces it
// prominently per `feedback_no_silent_drops_closed`.
//
// `introspection_degraded` is `string[]` — server emits the
// `SessionEntry.degraded_field` atoms which JSON-encode as strings.
// M-8 doesn't render individual values (those land in M-9 Sessions
// tab's per-row detail surface); a non-empty array implies the live
// state values may be stale.
// M-cluster M-8 / M-9b — shared live-introspection wire shape.
// Mirror of `Grappa.LiveIntrospection.AdminWire.live_state_json/0`.
// Same physical struct surfaces under `/admin/visitors[].live_state`
// (where it's `| null` per U-0 honesty) AND every
// `/admin/sessions[].live_state` (non-null since the latter is
// registry-driven). Single source per "Implement once, reuse
// everywhere".
export type AdminLiveState = {
  alive: boolean;
  pid_inspect: string;
  mailbox_len: number;
  memory_bytes: number;
  joined_channels: string[] | null;
  introspection_degraded: string[];
};

export type AdminVisitorLiveState = AdminLiveState;

export type AdminVisitor = {
  id: string;
  nick: string;
  network_slug: string;
  expires_at: string | null;
  identified: boolean;
  ip: string | null;
  inserted_at: string;
  live_state: AdminVisitorLiveState | null;
};

export type AdminVisitorsResponse = { visitors: AdminVisitor[] };

export async function adminListVisitors(token: string): Promise<AdminVisitor[]> {
  const res = await fetch("/admin/visitors", { headers: buildHeaders(token) });
  if (!res.ok) throw await readError(res);
  const body = (await res.json()) as AdminVisitorsResponse;
  return body.visitors;
}

export async function adminDeleteVisitor(token: string, id: string): Promise<void> {
  const res = await fetch(`/admin/visitors/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: buildHeaders(token),
  });
  if (!res.ok) throw await readError(res);
}

// M-cluster M-9b — admin Sessions tab wire types + fetch wrappers.
// Mirror of `Grappa.LiveIntrospection.AdminWire.t()`
// (lib/grappa/live_introspection/admin_wire.ex).
//
// Registry-driven: every row in the response represents a live
// `Session.Server` pid. `subject_label: null` IS the gemello of the
// U-0 honesty signal on /admin/visitors — DB row missing for a live
// pid (orphan pid: deleted via raw SQL / terminate race / etc.).
// Operator console renders "no DB row" instead of an opaque UUID
// so the divergence is loud.
//
// Mutations key on the composite `"<subject_kind>:<subject_id>:<network_id>"`
// string per the M-9a controller contract; cic constructs it
// client-side. Cic must NEVER round-trip `pid_inspect` back to the
// server — it's a human-readable label only.
export type AdminSessionLiveState = AdminLiveState;

export type AdminSession = {
  subject_kind: "user" | "visitor";
  subject_id: string;
  subject_label: string | null;
  // ISO8601 of MAX(accounts_sessions.last_seen_at) across the
  // subject's cookie sessions, or null when no cookie ever existed
  // (Bootstrap-spawned bouncer with no browser login). Bumped at
  // most every 60s by REST + WS authn paths — minute-resolution in
  // practice. Useful diagnostic for "is the user actually using
  // the PWA" alongside the live BEAM state.
  last_seen_at: string | null;
  network_id: number;
  live_state: AdminSessionLiveState;
};

export type AdminSessionsResponse = { sessions: AdminSession[] };

// Composite session id constructor — single source for the wire
// shape. Mirrors the server-side parse_session_id/1 in
// `lib/grappa_web/controllers/admin/sessions_controller.ex`.
export function adminSessionId(s: AdminSession): string {
  return `${s.subject_kind}:${s.subject_id}:${s.network_id}`;
}

export async function adminListSessions(token: string): Promise<AdminSession[]> {
  const res = await fetch("/admin/sessions", { headers: buildHeaders(token) });
  if (!res.ok) throw await readError(res);
  const body = (await res.json()) as AdminSessionsResponse;
  return body.sessions;
}

export async function adminDisconnectSession(token: string, id: string): Promise<void> {
  const res = await fetch(`/admin/sessions/${encodeURIComponent(id)}/disconnect`, {
    method: "POST",
    headers: buildHeaders(token),
  });
  if (!res.ok) throw await readError(res);
}

export async function adminTerminateSession(token: string, id: string): Promise<void> {
  const res = await fetch(`/admin/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: buildHeaders(token),
  });
  if (!res.ok) throw await readError(res);
}

// M-cluster M-10 — admin Networks tab wire types + fetch wrappers.
// Mirror of `Grappa.Networks.AdminWire.t()` composed with the nested
// `circuit_state` from `Grappa.Admission.NetworkCircuit.AdminWire.t()`
// (controller composition in `lib/grappa_web/controllers/admin/networks_controller.ex`).
//
// Three-valued cap contract per `Networks.update_network_caps/2`:
//   * `null` — explicit "unlimited" (operator-cleared)
//   * `0`    — degenerate lock-down ("allow none")
//   * `N>0`  — the cap itself
// Cic surfaces null/empty-input as "—" and parses an empty input
// field back to `null` on PATCH so the operator can clear a cap.
//
// `circuit_state: null` = no ETS row for the network (no admission
// failures observed). Distinct from a populated `circuit_state` with
// `state: "closed"` (had failures, sub-threshold). Per
// `feedback_no_localized_strings_server_side`: state + counts are
// typed; cic owns rendering ("never tripped" / "OPEN, retry in 12s" / etc).
//
// `state` is a typed string-literal union per CLAUDE.md "Atoms or
// `@type t :: literal | literal` — never untyped strings". Server-side
// `NetworkCircuit` emits only `:open | :closed` today; a future
// `:half_open` would be a deliberate edit here + a new arm in the
// renderer.
export type AdminCircuitStateKind = "open" | "closed";

export type AdminCircuitState = {
  state: AdminCircuitStateKind;
  failure_count: number;
  window_start_ms: number;
  cooled_at_ms: number;
  retry_after_seconds: number;
};

// U-3 (UD4): per-network live-session counts split by subject_kind.
// Mirrors `Grappa.Admission.live_counts/0`. Always present on every
// row of `GET /admin/networks` (never nil — Registry count is
// authoritative; zero counts are still a meaningful projection).
// AdminSessionsTab renders these alongside the operator-set caps
// ("Visitors: N/cap, Users: M/cap") so capacity is visible at a glance.
export type AdminLiveCounts = {
  visitors: number;
  users: number;
};

export type AdminNetwork = {
  id: number;
  slug: string;
  max_concurrent_visitor_sessions: number | null;
  max_concurrent_user_sessions: number | null;
  max_per_ip: number | null;
  inserted_at: string;
  updated_at: string;
  circuit_state: AdminCircuitState | null;
  live_counts: AdminLiveCounts;
};

export type AdminNetworksResponse = { networks: AdminNetwork[] };

// PATCH body is keys-optional per `Networks.update_network_caps/2`'s
// `%{optional(:max_concurrent_visitor_sessions) => ...,
// optional(:max_concurrent_user_sessions) => ...,
// optional(:max_per_ip) => ...}` contract: unsupplied keys keep
// their current value. Cic MUST only include keys whose value
// actually changed vs the server-echoed row — sending all keys on
// every edit creates a lost-update race (operator A's Save would
// silently roll back operator B's concurrently-saved change to the
// OTHER cap). CRIT-1 of M-10 review.
export type AdminNetworkCapsPatch = {
  max_concurrent_visitor_sessions?: number | null;
  max_concurrent_user_sessions?: number | null;
  max_per_ip?: number | null;
};

export async function adminListNetworks(token: string): Promise<AdminNetwork[]> {
  const res = await fetch("/admin/networks", { headers: buildHeaders(token) });
  if (!res.ok) throw await readError(res);
  const body = (await res.json()) as AdminNetworksResponse;
  return body.networks;
}

export async function adminPatchNetworkCaps(
  token: string,
  slug: string,
  body: AdminNetworkCapsPatch,
): Promise<AdminNetwork> {
  const res = await fetch(`/admin/networks/${encodeURIComponent(slug)}`, {
    method: "PATCH",
    headers: buildHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as AdminNetwork;
}

// 202 Accepted envelope: `{swept_count: number, swept_at: ISO8601}`.
// Cic surfaces `swept_count` in a transient success line; nothing else
// in the wire shape drives UI state today.
export type AdminReaperRunResponse = {
  swept_count: number;
  swept_at: string;
};

export async function adminRunReaper(token: string): Promise<AdminReaperRunResponse> {
  const res = await fetch("/admin/reaper/run", {
    method: "POST",
    headers: buildHeaders(token),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as AdminReaperRunResponse;
}

// POST /admin/circuit/:network_id/reset returns
// `{network_id, circuit_state: null}` (reset always leaves no ETS row).
// `network_id` echoes the path param for symmetry; cic uses the post-
// reset `circuit_state` to update the row directly.
export type AdminCircuitResetResponse = {
  network_id: number;
  circuit_state: AdminCircuitState | null;
};

export async function adminResetCircuit(
  token: string,
  networkId: number,
): Promise<AdminCircuitResetResponse> {
  const res = await fetch(`/admin/circuit/${networkId}/reset`, {
    method: "POST",
    headers: buildHeaders(token),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as AdminCircuitResetResponse;
}

// UX-6-B2 (2026-05-21) — admin Settings tab REST wire types.
// Mirror of `GrappaWeb.Admin.SettingsController` GET / PUT
// `/admin/settings`. Wire shape is the `Grappa.ServerSettings.
// public_view/0` re-shaped (atoms-out — active_host is the string
// `"embedded" | "litterbox"`).
export type AdminSettingsView = {
  upload: {
    active_host: "embedded" | "litterbox";
    image_per_file_cap_bytes: number;
    video_per_file_cap_bytes: number;
    document_per_file_cap_bytes: number;
    audio_per_file_cap_bytes: number;
    global_cap_bytes: number;
  };
};

export type AdminSettingsResponse = { settings: AdminSettingsView };

// PUT body shape — every key in `upload` is optional. Controller
// upserts only present keys (`apply_updates/1` per-key dispatch).
// Cic sends the full subtree on save to keep the payload trivial;
// the controller's tolerance keeps backward-compat with partial
// payloads.
export type AdminSettingsUpdate = {
  upload?: {
    active_host?: "embedded" | "litterbox";
    image_per_file_cap_bytes?: number;
    video_per_file_cap_bytes?: number;
    document_per_file_cap_bytes?: number;
    audio_per_file_cap_bytes?: number;
    global_cap_bytes?: number;
  };
};

export async function adminGetSettings(token: string): Promise<AdminSettingsView> {
  const res = await fetch("/admin/settings", { headers: buildHeaders(token) });
  if (!res.ok) throw await readError(res);
  const body = (await res.json()) as AdminSettingsResponse;
  return body.settings;
}

export async function adminPutSettings(
  token: string,
  body: AdminSettingsUpdate,
): Promise<AdminSettingsView> {
  const res = await fetch("/admin/settings", {
    method: "PUT",
    headers: buildHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readError(res);
  const respBody = (await res.json()) as AdminSettingsResponse;
  return respBody.settings;
}

export async function logout(token: string): Promise<void> {
  const res = await fetch("/auth/logout", {
    method: "DELETE",
    headers: buildHeaders(token),
  });
  if (!res.ok) throw await readError(res);
}

// #157 — IRREVERSIBLE total account wipe. `DELETE /me`: the server tears
// down the caller's live session(s), deletes the account + ALL associated
// state (DB cascade), and closes the live WS. 204 on success; the server
// 403s an admin user / anon visitor (registered-only — defense-in-depth
// mirroring the cic gate). DISTINCT from `logout` (#126 detach), which
// PRESERVES a persistent identity. Throws on any non-2xx so the caller
// (lib/lifecycle.deleteAccount) does NOT clear the local bearer on a
// still-existing account.
export async function deleteAccount(token: string): Promise<void> {
  const res = await fetch("/me", {
    method: "DELETE",
    headers: buildHeaders(token),
  });
  if (!res.ok) throw await readError(res);
}

// #126 — visitor `disconnect`: drop the upstream IRC connection but KEEP
// the cic/web session open. Registered-visitor-only server-side (403
// otherwise). 204 on success.
export async function disconnectSession(token: string): Promise<void> {
  const res = await fetch("/session/disconnect", {
    method: "POST",
    headers: buildHeaders(token),
  });
  if (!res.ok) throw await readError(res);
}

// #126 — visitor `reconnect`: respawn the upstream IRC session dropped by
// `disconnectSession`. Registered-visitor-only server-side. 204 on
// success; admission/spawn failures surface as the usual error envelopes.
export async function reconnectSession(token: string): Promise<void> {
  const res = await fetch("/session/reconnect", {
    method: "POST",
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

// Mirror of `GrappaWeb.DirectoryController.index/2`. The response IS the
// page object directly (no unwrap) — unlike `listChannels` the server
// returns `DirectoryPage` at the root, not a named key.
export async function listDirectory(
  token: string,
  networkSlug: string,
  opts: { sort?: "users" | "name"; q?: string; cursor?: string } = {},
): Promise<DirectoryPage> {
  const p = new URLSearchParams();
  if (opts.sort) p.set("sort", opts.sort);
  if (opts.q) p.set("q", opts.q);
  if (opts.cursor) p.set("cursor", opts.cursor);
  const qs = p.toString();
  const res = await fetch(
    `/networks/${encodeURIComponent(networkSlug)}/directory${qs ? `?${qs}` : ""}`,
    { headers: buildHeaders(token) },
  );
  if (!res.ok) throw await readError(res);
  return (await res.json()) as DirectoryPage;
}

// Mirror of `GrappaWeb.DirectoryController.refresh/2`. POSTs to kick off
// a background LIST refresh; server responds 202 Accepted.
export async function refreshDirectory(token: string, networkSlug: string): Promise<void> {
  const res = await fetch(`/networks/${encodeURIComponent(networkSlug)}/directory/refresh`, {
    method: "POST",
    headers: buildHeaders(token),
  });
  if (!res.ok) throw await readError(res);
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
//
// The render path is WS-driven; callers that want the row id (e.g.
// scrollback.ts's bucket-D post-success cursor advance) keep ONLY the
// id from this body and let the WS echo own the insert. Reading the
// body for any other purpose risks double-rendering on the race where
// WS lands first.
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
// name (+ optional UX-4 bucket F +k channel key); the server forwards
// a JOIN to the upstream session. The 202 envelope is `{ok: true}` —
// we don't read the body. `null` key omits the field; the empty
// string is treated as "no key" downstream so the wire shape
// stays consistent.
export async function postJoin(
  token: string,
  networkSlug: string,
  channelName: string,
  key: string | null,
): Promise<void> {
  const body: { name: string; key?: string } = { name: channelName };
  if (key !== null && key !== "") body.key = key;
  const res = await fetch(`/networks/${encodeURIComponent(networkSlug)}/channels`, {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify(body),
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

// UX-1 (2026-05-17) — mirror of `GrappaWeb.ArchiveController.delete/2`.
// DELETE /networks/:slug/archive/:target → 204 on success. Server
// dispatches by sigil (channel-shaped → delete_for_channel; otherwise
// → delete_for_dm) so cic just hands over the user-facing target as-is.
// On success the server broadcasts `archive_changed` on the user-topic;
// the dispatcher in `userTopic.ts` triggers `loadArchive(slug)` so the
// local cache refreshes without the caller plumbing the refetch.
export async function deleteArchiveEntry(
  token: string,
  networkSlug: string,
  target: string,
): Promise<void> {
  const res = await fetch(
    `/networks/${encodeURIComponent(networkSlug)}/archive/${encodeURIComponent(target)}`,
    {
      method: "DELETE",
      headers: buildHeaders(token),
    },
  );
  if (!res.ok) throw await readError(res);
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
//
// REV-H H2 (2026-05-22): operator-input subset of `ConnectionState`.
// `PATCH /networks/:id` accepts only `"connected"` (manual /connect)
// or `"parked"` (manual /disconnect); `"failed"` is server-derived
// (admission failure / network unreachable / k-line) and never
// requested by cic. Distinct type from `ConnectionState` so the
// 2-arm operator surface stays narrower than the 3-arm server-emit
// surface.
export type CredentialConnectionStateRequest = "connected" | "parked";

export type CredentialJson = {
  network: string;
  nick: string;
  realname: string | null;
  sasl_user: string | null;
  auth_method: string;
  auth_command_template: string | null;
  autojoin_channels: string[];
  connection_state: ConnectionState;
  connection_state_reason: string | null;
  connection_state_changed_at: string | null;
  inserted_at: string;
  updated_at: string;
};

export async function patchNetwork(
  token: string,
  networkSlug: string,
  body: { connection_state: CredentialConnectionStateRequest; reason?: string },
): Promise<CredentialJson> {
  const res = await fetch(`/networks/${encodeURIComponent(networkSlug)}`, {
    method: "PATCH",
    headers: buildHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as CredentialJson;
}

// ----- Admin-panel buckets 2-5 — REST CRUD wrappers -------------------
//
// Mirrors of the bucket-1/2/3 admin REST surface. All require an
// admin bearer token; visitor / non-admin sessions collapse to 403
// upstream (`:admin_authn`). Shapes match `Grappa.{Accounts,Networks,
// Networks.Servers,Networks.Credentials}.AdminWire.t()` server-side.

export type AdminUser = {
  id: string;
  name: string;
  is_admin: boolean;
  inserted_at: string;
  updated_at: string;
  live_session_count: number;
};

export type AdminUsersResponse = { users: AdminUser[] };

export async function adminListUsers(token: string): Promise<AdminUser[]> {
  const res = await fetch("/admin/users", { headers: buildHeaders(token) });
  if (!res.ok) throw await readError(res);
  const body = (await res.json()) as AdminUsersResponse;
  return body.users;
}

export type AdminUserCreate = {
  name: string;
  password: string;
  is_admin?: boolean;
};

export async function adminCreateUser(token: string, body: AdminUserCreate): Promise<AdminUser> {
  const res = await fetch("/admin/users", {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as AdminUser;
}

export async function adminUpdateUserAdmin(
  token: string,
  id: string,
  is_admin: boolean,
): Promise<AdminUser> {
  const res = await fetch(`/admin/users/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: buildHeaders(token),
    body: JSON.stringify({ is_admin }),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as AdminUser;
}

export async function adminUpdateUserPassword(
  token: string,
  id: string,
  password: string,
): Promise<AdminUser> {
  const res = await fetch(`/admin/users/${encodeURIComponent(id)}/password`, {
    method: "PUT",
    headers: buildHeaders(token),
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as AdminUser;
}

export async function adminDeleteUser(token: string, id: string): Promise<void> {
  const res = await fetch(`/admin/users/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: buildHeaders(token),
  });
  if (!res.ok) throw await readError(res);
}

// Bucket 1 — Network create/delete REST CRUD.

export type AdminNetworkCreate = {
  slug: string;
  max_concurrent_visitor_sessions?: number | null;
  max_concurrent_user_sessions?: number | null;
  max_per_ip?: number | null;
};

export async function adminCreateNetwork(
  token: string,
  body: AdminNetworkCreate,
): Promise<AdminNetwork> {
  const res = await fetch("/admin/networks", {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as AdminNetwork;
}

export async function adminDeleteNetwork(token: string, id: number): Promise<void> {
  const res = await fetch(`/admin/networks/${encodeURIComponent(String(id))}`, {
    method: "DELETE",
    headers: buildHeaders(token),
  });
  if (!res.ok) throw await readError(res);
}

// Bucket 1 — Server CRUD scoped under a network.

export type AdminServer = {
  id: number;
  network_id: number;
  host: string;
  port: number;
  tls: boolean;
  priority: number;
  enabled: boolean;
  inserted_at: string;
  updated_at: string;
};

export type AdminServerCreate = {
  host: string;
  port: number;
  tls?: boolean;
  priority?: number;
  enabled?: boolean;
};

export type AdminServerUpdate = Partial<AdminServerCreate>;

export type AdminServerDeleteResponse = { network_session_count: number };

export type AdminServersResponse = { servers: AdminServer[] };

export async function adminListServers(token: string, networkId: number): Promise<AdminServer[]> {
  const res = await fetch(`/admin/networks/${encodeURIComponent(String(networkId))}/servers`, {
    headers: buildHeaders(token),
  });
  if (!res.ok) throw await readError(res);
  const body = (await res.json()) as AdminServersResponse;
  return body.servers;
}

export async function adminAddServer(
  token: string,
  networkId: number,
  body: AdminServerCreate,
): Promise<AdminServer> {
  const res = await fetch(`/admin/networks/${encodeURIComponent(String(networkId))}/servers`, {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as AdminServer;
}

export async function adminUpdateServer(
  token: string,
  networkId: number,
  serverId: number,
  body: AdminServerUpdate,
): Promise<AdminServer> {
  const res = await fetch(
    `/admin/networks/${encodeURIComponent(String(networkId))}/servers/${encodeURIComponent(
      String(serverId),
    )}`,
    {
      method: "PUT",
      headers: buildHeaders(token),
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw await readError(res);
  return (await res.json()) as AdminServer;
}

export async function adminDeleteServer(
  token: string,
  networkId: number,
  serverId: number,
): Promise<AdminServerDeleteResponse> {
  const res = await fetch(
    `/admin/networks/${encodeURIComponent(String(networkId))}/servers/${encodeURIComponent(
      String(serverId),
    )}`,
    {
      method: "DELETE",
      headers: buildHeaders(token),
    },
  );
  if (!res.ok) throw await readError(res);
  return (await res.json()) as AdminServerDeleteResponse;
}

// #85 — Featured channels: operator config (admin CRUD) exposed
// read-only to users/visitors via the public on-display read.

// Public delivery shape — mirrors NetworksFeaturedChannelsWireLink.
export type FeaturedChannelLink = { name: string; description: string | null };
export type FeaturedChannelsResponse = { channels: FeaturedChannelLink[] };

// Admin shape — mirrors Grappa.Networks.FeaturedChannels.AdminWire.
export type AdminFeaturedChannel = {
  id: number;
  network_id: number;
  name: string;
  description: string | null;
  position: number;
  enabled: boolean;
  inserted_at: string;
  updated_at: string;
};

export type AdminFeaturedChannelCreate = {
  name: string;
  description?: string | null;
  position?: number;
  enabled?: boolean;
};

export type AdminFeaturedChannelUpdate = Partial<AdminFeaturedChannelCreate>;

export type AdminFeaturedChannelsResponse = { featured_channels: AdminFeaturedChannel[] };

// Public on-display read consumed by HomePane. `networkSlug` resolves
// via the :resolve_network plug (cross-user iso); 404 for a network the
// subject isn't on.
export async function getFeaturedChannels(
  token: string,
  networkSlug: string,
): Promise<FeaturedChannelLink[]> {
  const res = await fetch(`/networks/${encodeURIComponent(networkSlug)}/featured`, {
    headers: buildHeaders(token),
  });
  if (!res.ok) throw await readError(res);
  return ((await res.json()) as FeaturedChannelsResponse).channels;
}

export async function adminListFeaturedChannels(
  token: string,
  networkId: number,
): Promise<AdminFeaturedChannel[]> {
  const res = await fetch(
    `/admin/networks/${encodeURIComponent(String(networkId))}/featured_channels`,
    { headers: buildHeaders(token) },
  );
  if (!res.ok) throw await readError(res);
  return ((await res.json()) as AdminFeaturedChannelsResponse).featured_channels;
}

export async function adminAddFeaturedChannel(
  token: string,
  networkId: number,
  body: AdminFeaturedChannelCreate,
): Promise<AdminFeaturedChannel> {
  const res = await fetch(
    `/admin/networks/${encodeURIComponent(String(networkId))}/featured_channels`,
    { method: "POST", headers: buildHeaders(token), body: JSON.stringify(body) },
  );
  if (!res.ok) throw await readError(res);
  return (await res.json()) as AdminFeaturedChannel;
}

export async function adminUpdateFeaturedChannel(
  token: string,
  networkId: number,
  id: number,
  body: AdminFeaturedChannelUpdate,
): Promise<AdminFeaturedChannel> {
  const res = await fetch(
    `/admin/networks/${encodeURIComponent(String(networkId))}/featured_channels/${encodeURIComponent(
      String(id),
    )}`,
    { method: "PUT", headers: buildHeaders(token), body: JSON.stringify(body) },
  );
  if (!res.ok) throw await readError(res);
  return (await res.json()) as AdminFeaturedChannel;
}

export async function adminDeleteFeaturedChannel(
  token: string,
  networkId: number,
  id: number,
): Promise<void> {
  const res = await fetch(
    `/admin/networks/${encodeURIComponent(String(networkId))}/featured_channels/${encodeURIComponent(
      String(id),
    )}`,
    { method: "DELETE", headers: buildHeaders(token) },
  );
  if (!res.ok) throw await readError(res);
}

// Bucket 3 — Credential CRUD. URL composite (`:user_id/:network_id`)
// reflects the schema's composite primary key (no surrogate id).

export type AdminCredentialLiveState = AdminLiveState;

export type AdminCredential = {
  user_id: string;
  network_id: number;
  network_slug: string;
  nick: string;
  realname: string | null;
  sasl_user: string | null;
  auth_method: string;
  auth_command_template: string | null;
  autojoin_channels: string[];
  last_joined_channels: string[];
  connection_state: ConnectionState;
  connection_state_reason: string | null;
  connection_state_changed_at: string | null;
  inserted_at: string;
  updated_at: string;
  live_state: AdminCredentialLiveState | null;
  // Present on PUT responses only; index/GET shape excludes it.
  session_action?: "left_alone" | "stopped";
};

export type AdminCredentialsResponse = { credentials: AdminCredential[] };

export async function adminListCredentials(
  token: string,
  filters?: { user_id?: string; network_id?: number },
): Promise<AdminCredential[]> {
  const params = new URLSearchParams();
  if (filters?.user_id !== undefined) params.set("user_id", filters.user_id);
  if (filters?.network_id !== undefined) params.set("network_id", String(filters.network_id));
  const qs = params.toString();
  const url = qs === "" ? "/admin/credentials" : `/admin/credentials?${qs}`;
  const res = await fetch(url, { headers: buildHeaders(token) });
  if (!res.ok) throw await readError(res);
  const body = (await res.json()) as AdminCredentialsResponse;
  return body.credentials;
}

export type AdminCredentialCreate = {
  user_id: string;
  network_id: number;
  nick: string;
  auth_method: string;
  password?: string;
  sasl_user?: string;
  realname?: string;
  auth_command_template?: string;
  autojoin_channels?: string[];
};

export async function adminBindCredential(
  token: string,
  body: AdminCredentialCreate,
): Promise<AdminCredential> {
  const res = await fetch("/admin/credentials", {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as AdminCredential;
}

export type AdminCredentialUpdate = {
  nick?: string;
  sasl_user?: string;
  realname?: string;
  auth_method?: string;
  auth_command_template?: string;
  password?: string;
  autojoin_channels?: string[];
};

export async function adminUpdateCredential(
  token: string,
  userId: string,
  networkId: number,
  body: AdminCredentialUpdate,
): Promise<AdminCredential> {
  const res = await fetch(
    `/admin/credentials/${encodeURIComponent(userId)}/${encodeURIComponent(String(networkId))}`,
    {
      method: "PATCH",
      headers: buildHeaders(token),
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) throw await readError(res);
  return (await res.json()) as AdminCredential;
}

export async function adminUnbindCredential(
  token: string,
  userId: string,
  networkId: number,
): Promise<void> {
  const res = await fetch(
    `/admin/credentials/${encodeURIComponent(userId)}/${encodeURIComponent(String(networkId))}`,
    {
      method: "DELETE",
      headers: buildHeaders(token),
    },
  );
  if (!res.ok) throw await readError(res);
}

// Visitor session-sharing — mint endpoint. Visitor-only (server gives
// 403 to user subjects). Returns the signed token + ISO8601 expires_at
// for the share-link modal countdown.
export type ShareTokenMintResponse = {
  token: string;
  expires_at: string;
};

export async function mintShareToken(token: string): Promise<ShareTokenMintResponse> {
  const res = await fetch("/me/share-token", {
    method: "POST",
    headers: buildHeaders(token),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as ShareTokenMintResponse;
}

// Visitor session-sharing — consume endpoint. Unauthenticated by design:
// the signed token IS the auth credential. Returns the same shape as
// /auth/login so the caller can hand it to localStorage symmetric with
// the regular login flow.
export type ShareTokenConsumeResponse = LoginResponse;

export async function consumeShareToken(shareToken: string): Promise<ShareTokenConsumeResponse> {
  const res = await fetch("/auth/share/consume", {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({ token: shareToken }),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as ShareTokenConsumeResponse;
}
