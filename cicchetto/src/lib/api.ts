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
// S15/S3 — derive the upload-settings wire shape from the codegen
// mirror of `Grappa.ServerSettings.Wire.upload_view/0`; the
// `active_host` closed set (`"embedded" | "litterbox"`) is pinned by
// the server typespec, not re-hardcoded here.
import type {
  AccountsAdminWireT,
  AdminEventsWireEvent,
  AdmissionNetworkCircuitAdminWireT,
  ChannelDirectoryStatus,
  ChannelDirectoryWireEntry,
  ChannelDirectoryWireIndexPayload,
  LiveIntrospectionAdminWireLiveStateJson,
  LiveIntrospectionAdminWireT,
  NetworksAdminWireT,
  NetworksCredentialConnectionState,
  NetworksCredentialsAdminWireSessionAction,
  NetworksCredentialsAdminWireT,
  NetworksFeaturedChannelsAdminWireT,
  NetworksFeaturedChannelsWireIndexPayload,
  NetworksFeaturedChannelsWireLink,
  NetworksNetworkServicesFlavor,
  NetworksServersAdminWireT,
  NetworksWireAvailableNetworkRow,
  NetworksWireChannelJson,
  NetworksWireConnectionInfo,
  NetworksWireCredentialJson,
  NetworksWireHomeData,
  NetworksWireHomeNetworkRow,
  NetworksWireNetworkWithNickJson,
  NetworksWireVisitorNetworkWithNickJson,
  NotifyWireEntry,
  QueryWindowsWireWindowsEntry,
  RateLimitWireWebSessionSeveredEvent,
  ScrollbackMessageKind,
  ScrollbackWireArchiveWireEntry,
  ScrollbackWireT,
  ServerSettingsWireUploadView,
  SessionLogWireListResult,
  SessionLogWireT,
  SessionWireBanlistBundlePayload,
  SessionWireBanlistEntry,
  SessionWireLinksBundlePayload,
  SessionWireLinksEntry,
  SessionWireMentionsBundleMessage,
  SessionWireNamesReplyPayload,
  SessionWireServerReplyPayload,
  SessionWireServerReplySource,
  SessionWireWhoisBundlePayload,
  SessionWireWhoisExtraLine,
  SessionWireWhoReplyPayload,
  SessionWireWhoUser,
  SessionWireWhowasBundlePayload,
  SubjectSearchAdminWireResultJson,
  VhostsAdminWireGrantJson,
  VhostsAdminWireVhostJson,
  VisitorsAdminWireNetworkJson,
  VisitorsAdminWireT,
  WindowCountsSeverity,
} from "./wireTypes";

// Exported so sibling REST clients (e.g. `themesApi.ts`) reuse the exact
// same JSON header shape — content-type + the `x-grappa-client-id` header
// every grappa request carries — rather than re-deriving it and drifting.
export function buildHeaders(token?: string): HeadersInit {
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
  // #152 — login-Advanced ident + realname (both optional). Sent raw;
  // the server sanitizes (leading-`~` strip) + shape-validates.
  ident?: string;
  realname?: string;
  // #363 — ephemeral "incognito" session (visitor path only). Present +
  // true → the fresh anon visitor is provisioned incognito (short linger
  // TTL, deleted ~1h after the browser closes). The server ignores it on
  // the account path; omitted → an ordinary persistent session.
  incognito?: boolean;
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
  //
  // #211 phase 7 — `nick`/`ident`/`realname` DROPPED from the subject too
  // (network_slug went in phase 6). A visitor is multi-network with
  // per-network identity on the GET /networks rows; the subject carries
  // only the identity-wide `{id, registered}`. Mirrors the server-side
  // `Grappa.Visitors.Wire` drop + the `isValidSubject` relaxation in
  // auth.ts. `registered` is derived server-side (≥1 NickServ credential).
  // #363 — `incognito` = this visitor session is ephemeral (deleted ~1h
  // after the browser closes). cic reads it to disable share-session (an
  // ephemeral session isn't portable). Optional so a subject persisted
  // before this field landed still validates (read as non-incognito);
  // fresh logins always carry it. Server-derived from `visitors.incognito`.
  | { kind: "visitor"; id: string; registered?: boolean; incognito?: boolean };

export type AuthenticatedLoginResponse = {
  token: string;
  subject: Subject;
};

export type TotpChallengeResponse = {
  two_factor_required: true;
  challenge_token: string;
};

export type PasskeyOptions = {
  challenge_id: string;
  public_key: Record<string, unknown>;
};

export type PasskeyChallengeResponse = {
  two_factor_required: true;
  passkey_options: PasskeyOptions;
  totp_available: boolean;
  challenge_token: string | null;
};

export type LoginResponse =
  | AuthenticatedLoginResponse
  | TotpChallengeResponse
  | PasskeyChallengeResponse;

export type TotpEnrollment = {
  enrollment_token: string;
  secret: string;
  provisioning_uri: string;
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
// #267 — server-authoritative per-window count snapshot. The `mentions`
// count + `severity` are the pieces cic renders directly (server is
// authority for mentions — a client-side regex bump never rebuilt on
// reconnect). `messages`/`events` are ALSO present but cic keeps deriving
// those locally (the events badge is presence-filter-aware, #239 — the
// server counts unfiltered). Mirror of `Grappa.WindowCounts.t/0`.
export type ServerWindowCounts = {
  messages: number;
  mentions: number;
  events: number;
  severity: WindowCountsSeverity;
};

// `/me` `unread_counts` envelope. Nested `%{slug => %{chan =>
// ServerWindowCounts}}` mirror of `read_cursors`, keyed only for channels
// the subject already has a cursor on (no cursor = absent; cic falls back
// to the per-channel join reply seed). #267 widened the per-channel value
// from `{messages, events}` to the full snapshot (adds mentions +
// severity). cic consumes via `selection.ts`'s `/me` effect (messages/
// events → serverSeedCounts) + `mentions.ts`'s `/me` effect (mentions).
export type UnreadCountsEnvelope = Record<string, Record<string, ServerWindowCounts>>;

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
// #410 — single-sourced to the codegen mirror of
// `Grappa.Networks.Credential.connection_state/0`. Re-exported under the
// domain name so call sites keep `ConnectionState`, not the leaky codegen
// alias. (Was a hand literal union pinned by `_Assert_ConnectionState`.)
export type ConnectionState = NetworksCredentialConnectionState;

// #349 — per-network NickServ services flavor. Server-owned enum
// (`Grappa.Networks.Network.services_flavor`, set by the operator at
// bind) that tells cic which per-network REGISTER / verify command
// template to build for the registration wizard (see
// `lib/registrationTemplates.ts`). Closed set — the wizard button is
// hidden for `"unknown"` and `null` (no template to register against).
// `null` = a legacy credential bound before the field existed / an
// operator who left it unset. The registration wizard is the only
// consumer today.
// #410 — single-sourced to the codegen mirror of
// `Grappa.Networks.Network.services_flavor`.
export type ServicesFlavor = NetworksNetworkServicesFlavor;

// #474 scope B — the live upstream connection facts a network row carries
// under `connection` (which box the socket dialled, TLS, +r registered).
// Re-exported under the domain name (mirror of ConnectionState/ServicesFlavor)
// so ServerInfoCard imports `ConnectionInfo`, not the leaky codegen alias.
export type ConnectionInfo = NetworksWireConnectionInfo;

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
export type HomeNetworkRow = NetworksWireHomeNetworkRow;

// #211 phase 6 / #481 — a network AVAILABLE for a subject to connect
// on-demand (`visitor_enabled − attached`). Rendered on the shared home
// page's "available to connect" section (ruling C). #481 populates it for
// BOTH subjects (was visitor-only).
// Mirror of server-side `Grappa.Networks.Wire.available_network_row/0`.
export type AvailableNetworkRow = NetworksWireAvailableNetworkRow;

// UX-4 bucket B / #211 phase 6 — `home_data` envelope. Populated for
// BOTH subjects now (ruling A — the user + visitor home pages are the
// SAME data-driven component). `networks` = attached; `available_networks`
// = the on-demand self-serve tier — populated for BOTH subjects (#481).
// Nested (NOT flat) so future home cards land as sibling keys without
// touching every caller.
export type HomeData = NetworksWireHomeData;

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
      // #211 phase 7 — `nick`/`ident`/`realname` DROPPED from the subject.
      // A visitor is multi-network; per-network identity (nick/ident/
      // realname) lives on the GET /networks rows, not the identity-wide
      // /me scalar. Mirrors the server-side `Grappa.Visitors.Wire` drop.
      // S16 — mirror the server contract: `me_json.ex` renders
      // `DateTime.t() | nil` (generated `VisitorsWireT.expires_at:
      // string | null`). Post-phase-7 a registered visitor keeps its
      // anon-shaped `expires_at` (registration is derived from the
      // credentials, not a cleared TTL); legacy permanent rows carry
      // `expires_at = NULL` ("indefinite").
      expires_at: string | null;
      // `registered` = NickServ identity present (the detach / quit gate).
      // #211 phase 7 — DERIVED server-side (≥1 credential with a committed
      // NickServ secret), not a stored flag; cic just reads the boolean.
      // Optional so test mocks predating the field don't need touching;
      // production /me always emits it.
      registered?: boolean;
      // #363 — this visitor session is incognito (ephemeral). cic reads it
      // to disable share-session; the linger countdown still derives from
      // `expires_at`. Optional for the same test-mock reason as `registered`.
      incognito?: boolean;
      read_cursors?: ReadCursorsEnvelope;
      // Bucket C (2026-06-01) — visitors get the same envelope shape;
      // empty `{}` for a fresh visitor (no cursors yet).
      unread_counts?: UnreadCountsEnvelope;
      // PWA icon badge door #2 (2026-06-21) — visitors get the same
      // scalar; seeds the badge signal at login.
      badge_count?: number;
      // #211 phase 6 (ruling A) — visitors now carry a POPULATED
      // `home_data` (was literal-`null`): the user + visitor home pages
      // are the SAME data-driven component. Optional so test mocks
      // predating the field don't need touching; production /me always
      // emits it. The union discriminates on `kind`, not this field.
      home_data?: HomeData;
    };

// Display-nick for a `MeResponse` — `user.name` for users. #211 phase 7 —
// a visitor has NO identity-wide nick (per-network identity lives on the
// GET /networks rows), so the visitor branch returns the generic "Visitor"
// label. For any per-network "what is my nick here" use
// `ownNickForNetwork(net, me)`; for a visitor display label that needs a
// concrete nick (delete-confirmation), resolve the SELECTED network row's
// nick via `visitorNetworkNick(net)`.
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
  return me.kind === "user" ? me.name : "Visitor";
}

// #478 — a visitor's confirmation nick for a SPECIFIC network row. The
// retired lowest-id "anchor" pick is gone: the caller passes the network the
// UI targets (the focused/selected row) and this returns its nick, narrowed to
// visitor rows (a user row → null; users confirm by account name via
// `displayNick`). Used by the SettingsDrawer delete-confirmation gate now that
// a visitor subject carries no identity-wide nick. `null` in → `null` out (the
// button is withheld until /networks resolves).
export function visitorNetworkNick(net: Network | null): string | null {
  return net != null && net.kind === "visitor" ? net.nick : null;
}

// Per-network own IRC nick — the canonical answer to "which nick am I
// running as on this network". Single source for the wire-vs-account
// disambiguation.
//
// #211 phase 6 — resolution is now subject-agnostic AND per-network: the
// nick comes from the `Network` ROW (`net.nick`), which BOTH subjects
// carry (the visitor row converged onto the user twin, ruling A). A
// visitor is multi-network now, so the pre-phase-6 `me.network_slug ===
// net.slug ? me.nick : null` singular match is retired — the answer is
// simply the per-network row's nick for both kinds. `me` is still taken
// (kept for the null-guard + call-site symmetry) but the nick no longer
// depends on the subject scalar.
//
// Resolution rules:
//   * null me      → `null` (not logged in).
//   * any network  → `net.nick` (the per-network IRC nick, kept live by
//     the `own_nick_changed` user-topic event + refetched on
//     connection_state changes).
//
// Use everywhere a per-network "own nick" comparison is made: the
// channels-loop self-JOIN/PART detection, the query-windows-loop
// own-nick skip, the DM-listener loop subscription topic, the
// ScrollbackPane self-highlight + mention-match.
export function ownNickForNetwork(net: Network, me: MeResponse | null | undefined): string | null {
  if (me == null) return null;
  return net.nick;
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
export type UserNetwork = NetworksWireNetworkWithNickJson;

export type VisitorNetwork = NetworksWireVisitorNetworkWithNickJson;

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
  // #211 phase 7 — per-network ident + realname (nullable). Optional on the
  // raw type for legacy fixtures / mid-rollout servers that predate them;
  // `tagNetwork` defaults a missing value to null.
  ident?: string | null;
  realname?: string | null;
  connection_state?: ConnectionState;
  connection_state_reason?: string | null;
  connection_state_changed_at?: string | null;
  // #349 — optional on the raw type for legacy fixtures / mid-rollout
  // servers that predate the field; `tagNetwork` defaults a missing
  // value to null (→ wizard button hidden).
  services_flavor?: ServicesFlavor | null;
  // #474 scope B — the live upstream connection facts (null when the
  // session is not live). Optional on the raw type for legacy fixtures /
  // mid-rollout servers that predate it; `tagNetwork` defaults a missing
  // value to null (→ the server-info rail shows no connection card).
  connection?: ConnectionInfo | null;
  inserted_at: string;
  updated_at: string;
};

// Boundary tagger — promotes a raw wire `RawNetwork` to a typed
// `Network` discriminated by the server-set `kind` field. Called in
// `lib/networks.ts`'s networks resource.
//
// #211 phase 6 — BOTH subjects now carry nick + connection_state (the
// visitor row converged onto the user twin, ruling A). So the field
// validation is subject-agnostic: a missing nick / connection_state is
// a server contract violation for EITHER kind and the row is dropped
// (returns null) so the caller filters before binding into the reactive
// store. `kind` comes straight off the wire (server emits it
// explicitly, no-silent-drops B6.9a HIGH-24); the pre-phase-6 nick-based
// inference fallback is retired — a visitor row now HAS a nick, so
// "nick present ⇒ user" no longer holds.
export function tagNetwork(raw: RawNetwork): Network | null {
  // Default a missing `kind` to "user" only for the rare legacy fixture
  // that predates the explicit discriminator; production always emits it.
  const kind = raw.kind ?? "user";

  if (raw.nick === undefined || raw.nick === "") {
    console.error(
      `tagNetwork: ${kind} subject but RawNetwork.nick missing for slug=${raw.slug} — server contract violation (network_with_nick_to_json / visitor_network_to_json should have populated it). Dropping the row from the typed networks list. See codebase review 2026-05-12 cic H4.`,
    );
    return null;
  }
  if (raw.connection_state === undefined) {
    console.error(
      `tagNetwork: ${kind} subject but RawNetwork.connection_state missing for slug=${raw.slug} — server contract violation. Dropping the row from the typed networks list.`,
    );
    return null;
  }
  return {
    kind,
    id: raw.id,
    slug: raw.slug,
    nick: raw.nick,
    ident: raw.ident ?? null,
    realname: raw.realname ?? null,
    connection_state: raw.connection_state,
    connection_state_reason: raw.connection_state_reason ?? null,
    connection_state_changed_at: raw.connection_state_changed_at ?? null,
    connection: raw.connection ?? null,
    services_flavor: raw.services_flavor ?? null,
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
export type ChannelEntry = NetworksWireChannelJson;

// Mirror of `GrappaWeb.DirectoryController.index/2` wire shape.
// `status` indicates the staleness of the captured list; `captured_at` is
// null when no list has been captured yet (status "empty"). `next_cursor`
// is null on the final page.
// `featured` (#85) is true when the channel is in its network's
// enabled `network_featured_channels` set — re-derived server-side on
// every directory fetch (on-display freshness). No top-pinning; the
// sort order is unchanged.
export type DirectoryEntry = ChannelDirectoryWireEntry;

// #410 — single-sourced to the codegen mirror of
// `Grappa.ChannelDirectory.Wire` status closed set.
export type DirectoryStatus = ChannelDirectoryStatus;

export type DirectoryPage = ChannelDirectoryWireIndexPayload;

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
// #410 — single-sourced to the codegen mirror of
// `Grappa.Scrollback.Message`'s `kind()` closed set
// (`SCROLLBACK_MESSAGE_KIND` const + `ScrollbackMessageKind` type in
// wireTypes.ts). Re-exported under the pervasive domain name; the runtime
// allowlist `VALID_MESSAGE_KINDS` (wireNarrow.ts) derives from the SAME
// const, so type + Set share ONE source. (Was a hand literal union pinned
// by `_Assert_MessageKind`.)
export type MessageKind = ScrollbackMessageKind;

// Kind class for the unread-badge memo derivation (2026-06-01,
// unread-badges-from-cursor cluster) + the notify/push gate (#395). The
// content kinds and their unread PROJECTION are declared ONCE here: each
// content kind maps to whether it is notify-worthy (badge/push eligible).
//
//   * "notify" — privmsg + action (CTCP /me): a real person's message.
//     Counts as unread AND raises a badge/push.
//   * "unread" — notice: services chatter (NickServ/ChanServ/bots).
//     Counts as unread but NEVER badges/pushes.
//
// Both CONTENT_KINDS (the "real messages" the operator wants the bold
// sidebar/bottom-bar badge for — presence kinds are the dimmer indicator)
// and NOTIFY_KINDS derive from THIS one map, so the notify-worthy set is a
// SUBSET of the unread-content set BY CONSTRUCTION — not two hand-maintained
// literals that happen to agree (pre-#395, pushTriggers.ts held its own
// ["privmsg","action"] copy separate from this CONTENT_KINDS). Mirror of the
// server SSOT `Grappa.Scrollback.Message.@content_kind_projection`
// (content_kinds/0 + notify_kinds/0). The classifier is single-sourced here
// so the in-pane unread marker, the sidebar/bottom-bar memos, and the
// foreground notify gate all share one definition.
const CONTENT_KIND_PROJECTION: ReadonlyMap<MessageKind, "notify" | "unread"> = new Map<
  MessageKind,
  "notify" | "unread"
>([
  ["privmsg", "notify"],
  ["notice", "unread"],
  ["action", "notify"],
]);

export const CONTENT_KINDS: ReadonlySet<MessageKind> = new Set(CONTENT_KIND_PROJECTION.keys());

// #395 — the notify-worthy subset (the kinds that raise a badge/push).
// Derived by selecting the "notify" rows of the projection, so it can NEVER
// contain a kind absent from CONTENT_KINDS: badge-worthy ⊆ unread by
// construction. `pushTriggers.ts` imports THIS instead of a local literal.
export const NOTIFY_KINDS: ReadonlySet<MessageKind> = new Set(
  [...CONTENT_KIND_PROJECTION].filter(([, projection]) => projection === "notify").map(([k]) => k),
);

export const isContentKind = (k: MessageKind): boolean => CONTENT_KINDS.has(k);
export const isPresenceKind = (k: MessageKind): boolean => !CONTENT_KINDS.has(k);

export type ScrollbackMessage = ScrollbackWireT;

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
  // #216 — per-network ISUPPORT capability set. This is a USER-topic event
  // (like own_nick_changed); the live 005 edge broadcasts it on
  // `Topic.user/1` (handled in userTopic.ts). It ALSO rides the per-channel
  // cold-WS-subscribe snapshot (push_isupport_if_live in
  // push_channel_snapshot) because the network is already resolved there —
  // so the SAME kind must narrow on BOTH topics (mirrors how joined/kicked/
  // members_seeded are dual-declared). subscribe.ts dispatches it into
  // `seedIsupport` exactly like userTopic.ts. Same flat wire shape both
  // ways; last-write-wins idempotent, so a per-channel snapshot arriving
  // after the live user-topic event is safe.
  | {
      kind: "isupport_changed";
      network_id: number;
      chanmodes_a: string[];
      chanmodes_b: string[];
      chanmodes_c: string[];
      chanmodes_d: string[];
      prefix: Record<string, string>;
    }
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
      // S13 — server contract is `pos_integer() | nil`; nil when the
      // failing numeric was never recorded (cold-subscribe snapshot).
      numeric: number | null;
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
    }
  // #267 — server-authoritative per-window count snapshot. Emitted on the
  // per-channel topic after a new message persists AND on cursor advance
  // (re-seeds peer devices). cic reads `mentions` (server owns the mention
  // count) + `severity`; `messages`/`events` are informational (cic keeps
  // deriving those locally for the presence-filter, #239).
  | {
      kind: "window_counts";
      channel: string;
      messages: number;
      mentions: number;
      events: number;
      severity: WindowCountsSeverity;
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
//
// S43 — `network_id` mirrors the field the server emits on each entry
// (`windows_entry/0`). It is redundant on cic (the network is the map
// key) but its presence pins the type to the generated
// `QueryWindowsWireWindowsEntry` (see `_Assert_QueryWindowEntry`), and
// the `query_windows_list` narrower now validates each entry against
// this shape instead of a bare cast.
export type QueryWindowEntry = QueryWindowsWireWindowsEntry;

// #247 — one /notify watch-list entry (Notify.Wire `entry/0`,
// codegen-pinned by `_Assert_NotifyEntry`). `nick` is the display form
// (first-add-wins); `network_id` is redundant on cic (map key) but
// pins the type to the generated `NotifyWireEntry` — same S43 rationale
// as `QueryWindowEntry` above.
export type NotifyEntry = NotifyWireEntry;

// Per-message item in the `mentions_bundle` payload (Session.Wire
// `mentions_bundle_message/0`). Deliberately stripped vs
// `ScrollbackMessage`: no id/network/meta — the bundle is a
// cross-channel summary view that doesn't need persistence keys.
// S14 — `kind` is the `Message.kind()` closed set (same as
// `ScrollbackMessage.kind`); the server typespec now pins the literal
// union so codegen emits it and `_Assert_MentionsBundleMessage` gates
// this mirror.
export type MentionsBundleMessage = SessionWireMentionsBundleMessage;

// C2 — WHOIS bundle payload. Mirrors `Grappa.Session.Wire.whois_bundle/3`.
// Aggregated reply to `/whois <nick>` issued by the operator. Every
// upstream-derived field is nullable: a stripped-down upstream (or a
// non-existent target) may emit only 318 RPL_ENDOFWHOIS, in which case
// the bundle has only `target` populated and cic renders a "no such
// nick" surface. `channels` is the joined list with mode prefixes
// preserved (e.g. ["@#italia", "+#grappa"]).
export type WhoisBundle = Omit<SessionWireWhoisBundlePayload, "kind">;

// #221 — one free-form / unhandled WHOIS-leg line relayed verbatim.
// Mirrors `Grappa.Session.Wire.whois_extra_line/0`. `numeric` is the
// source RPL_* code; `text` the upstream trailing (network-defined
// free-form, so cic renders it as-is — no typed field to localize).
export type WhoisExtraLine = SessionWireWhoisExtraLine;

// #140 — /names roster bundle payload. Mirrors
// `Grappa.Session.Wire.names_reply/3`. Ephemeral reply to `/names
// [#chan]`: the server buffers the 353/366 burst and emits ONE typed
// event with the full roster (same `MemberEntry` shape as
// `members_seeded`, the authoritative sidebar set — this is a parallel
// VIEW). cic renders a grouped, scrollable, dismissable modal; clicking
// a nick opens a query. NOT persisted to scrollback.
export type NamesReply = Omit<SessionWireNamesReplyPayload, "kind">;

// #169 — one parsed 352 RPL_WHOREPLY row for the /who modal. Mirrors
// `Grappa.Session.Wire.who_user/1`. A SUPERSET of `MemberEntry` (adds
// user/host/server/hops/realname/channel). `modes` is the raw WHO flags
// STRING (e.g. "H@" = here + op), NOT the MemberEntry prefix-list — the
// modal renders it verbatim. `hops`/`realname` are null when the server
// omits the trailing field. WHOX (354) is not handled; the shape leaves
// room for a future handler to add account etc.
export type WhoUser = SessionWireWhoUser;

// #169 — /who roster bundle payload. Mirrors
// `Grappa.Session.Wire.who_reply/3`. Ephemeral reply to `/who <#chan|nick>`:
// the server folds the 352 burst and drains on 315 into ONE typed event
// with the parsed per-user rows. cic renders a dismissable per-user table
// (WhoModal); clicking a nick opens a query. NOT persisted to scrollback.
export type WhoReply = Omit<SessionWireWhoReplyPayload, "kind">;

// #127 — /info, /version, /motd reply bundle. Mirrors
// `Grappa.Session.Wire.server_reply/3`. Ephemeral reply to an explicit
// `/info` (371/374), `/version` (351) or `/motd` (375/372/376/422): the
// server folds the reply burst and drains ONE typed event with the raw
// lines + a typed `source`. cic maps `source` to a human title (the server
// emits no display strings) and renders a dismissable scrollable retro
// modal (ServerReplyModal). NOT persisted; connect-time MOTD is unaffected
// (it stays on the $server window). `source` mirrors
// `SessionWireServerReplySource`.
// #410 — single-sourced to the codegen mirror of the Session.Wire
// server-reply `source` closed set.
export type ServerReplySource = SessionWireServerReplySource;
export type ServerReply = Omit<SessionWireServerReplyPayload, "kind">;

// P-0c — WHOWAS bundle payload. Mirrors `Grappa.Session.Wire.whowas_bundle/3`.
// Aggregated reply to `/whowas <nick>` issued by the operator. The
// most-recent historical entry is projected into the user/host/realname/
// server/logoff_time fields by the server. `not_found: true` is the 406
// ERR_WASNOSUCHNICK case — historical fields stay null and cic renders
// a "no history" surface. `logoff_time` ships as the upstream-supplied
// localized ctime string (server emits it verbatim — cic does NOT
// parse).
export type WhowasBundle = Omit<SessionWireWhowasBundlePayload, "kind">;

// #376 — one ban entry from a 367 RPL_BANLIST row. Mirrors
// `Grappa.Session.Wire.banlist_entry/0`. `mask` is the ban target
// (`nick!user@host` or `*!*@host`); `setter` is the nick/mask that set
// it; `set_ts` is the RAW upstream unix-epoch string (server ships it
// verbatim per `feedback_no_localized_strings_server_side` — cic formats
// it to the viewer's locale). `setter`/`set_ts` are null when the ircd
// omits them (older ircds / solanum send only the mask).
export type BanlistEntry = SessionWireBanlistEntry;

// #376 — BANLIST bundle payload. Mirrors `Grappa.Session.Wire.banlist_bundle/3`.
// Aggregated reply to `/banlist <#chan>` (or a raw `MODE #chan b`). Unlike
// WhowasBundle (most-recent entry only) it ships ALL `entries` — a ban
// list is a set of rows — in the wire order the ircd sent them. `channel`
// is the ASCII-folded channel (A-Z only; #525 corrected #364).
export type BanlistBundle = Omit<SessionWireBanlistBundlePayload, "kind">;

// #238 — one server node from a 364 RPL_LINKS row. Mirrors
// `Grappa.Session.Wire.links_entry/0`. `server` is the node; `linked_to`
// its uplink (the root self-links, server === linked_to); `hopcount` the
// distance/depth. `linked_to`/`hopcount`/`description` are null only when
// the upstream line is malformed. Pinned to the generated
// SessionWireLinksEntry by `_Assert_LinksEntry`.
export type LinksEntry = SessionWireLinksEntry;

// #238 — LINKS topology bundle payload. Mirrors
// `Grappa.Session.Wire.links_bundle/2`. Aggregated reply to `/links [<mask>]`:
// the server folds the 364 burst and drains ONE typed event on 365 with ALL
// server nodes (a topology is a set). cic reconstructs the spanning tree from
// the `linked_to` parent edges (LinksModal, an interactive SVG map). An EMPTY
// `entries` list is the restricted/hidden-topology signal. NOT persisted.
export type LinksReply = Omit<SessionWireLinksBundlePayload, "kind">;

// #581 — "recover my identity" guided recovery. Two transient user-topic
// events (recover_progress / recover_result) drive the RecoverModal progress
// view. `step` / `status` / `outcome` are closed sets (atoms-in-allowlist,
// narrowed strictly at ingress — an unknown value drops that one presentational
// ping). The result `reason` stays a plain `string | null` on the wire arm
// (NOT hardened to the known token union) so an additive server reason token
// can never drop a TERMINAL result event (unknown-is-never-fatal, #447) — the
// modal localizes the known tokens (`wrong_password` / `nick_unavailable` /
// `services_declined`) and shows generic copy otherwise, the friendlyChannelError
// posture.
export type RecoverStep = "identify" | "register" | "nick" | "recover" | "release";
export type RecoverStatus = "running" | "ok" | "failed";
export type RecoverOutcome = "succeeded" | "failed";
export type RecoverResultReason = "wrong_password" | "nick_unavailable" | "services_declined";

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
      // #229 — per-session USER-mode set, parsed from 221 RPL_UMODEIS +
      // self-MODE echoes server-side. The `/mode <nick>` / `/umode` modal
      // marks which umodes are active from this. Rides `Topic.user/1`
      // (per-session, not per-channel) and is cold-snapshotted on the
      // user-topic after-join push (unlike isupport's per-channel snapshot
      // — umodes are reachable with zero channels). userTopic.ts dispatches
      // into `seedUmodes(network_id, modes)`. `modes` is the sorted letter
      // list (sign stripped — a umode is set or not).
      kind: "umode_changed";
      network_id: number;
      modes: string[];
    }
  | {
      // #249 — per-session SUPPORTED user-mode set, parsed from 004 RPL_MYINFO
      // server-side. The AVAILABILITY set (distinct from umode_changed's ACTIVE
      // set): the `/umode` modal drives its togglable letters from this, exactly
      // as #216's isupport CHANMODES drives channel-mode toggles. Rides
      // `Topic.user/1` (per (subject, network)) and is cold-snapshotted on the
      // user-topic after-join push (umodes are reachable with zero channels).
      // userTopic.ts dispatches into `seedSupportedUmodes(network_id, modes)`.
      // `modes` is the sorted letter list the server advertised.
      kind: "supported_umodes_changed";
      network_id: number;
      modes: string[];
    }
  | {
      // #216 — per-network ISUPPORT channel-mode capability set, parsed
      // from 005 RPL_ISUPPORT CHANMODES= + PREFIX= server-side. The
      // `/mode` modal drives its available toggles from this. Rides
      // `Topic.user/1` (per-network, not per-channel) and is cold-
      // snapshotted on the per-channel after-join push. userTopic.ts
      // dispatches into `seedIsupport(network_id, ...)`. The four
      // CHANMODES classes are flat top-level fields (wire payloads are
      // flat; the codegen/biome formatters disagree on nested objects).
      kind: "isupport_changed";
      network_id: number;
      chanmodes_a: string[];
      chanmodes_b: string[];
      chanmodes_c: string[];
      chanmodes_d: string[];
      prefix: Record<string, string>;
    }
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
      // #211 phase 6 — nullable: a VISITOR credential's transition
      // carries user_id: null (visitor_id set instead — the XOR FK).
      user_id: string | null;
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
      // LusersCard pinned at the top of the current window (#231).
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
  | ({ kind: "banlist_bundle" } & BanlistBundle)
  | ({ kind: "links_bundle" } & LinksReply)
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
      // S13 — server contract is `pos_integer() | nil`; nil when the
      // failing numeric was never recorded (cold-subscribe snapshot).
      numeric: number | null;
    }
  | {
      kind: "kicked";
      network: string;
      channel: string;
      state: "kicked";
      by: string | null;
      reason: string | null;
    }
  // #292 — `version` is the deployed bundle's semver. The server OMITS the
  // wire key when unknown, so the generated `CicWireBundleHashPayload` now
  // types it `version?: string` (cross-surface S2 fixed codegen to preserve
  // `optional(...)` instead of over-claiming it required). The narrower
  // normalises absent / malformed → null, so this post-narrow consumer
  // shape is `string | null`. Drives the refresh bar's "current X →
  // available Y" display.
  | { kind: "bundle_hash"; hash: string; version: string | null }
  // UX-6-B2 (2026-05-21) — operator-visible server-settings reactive
  // signal. Fired on `Admin.SettingsController.update/2` fan-out AND
  // on after-join snapshot from `GrappaChannel.push_server_settings/1`
  // (parity with `bundle_hash`). Wire shape mirrors
  // `Grappa.ServerSettings.Wire.server_settings_changed/1` (atoms-out).
  | {
      kind: "server_settings_changed";
      // S15 — derives from the generated `ServerSettingsWireUploadView`
      // (drift-gated against `Grappa.ServerSettings.Wire`); the
      // `active_host` closed set is no longer re-hardcoded here.
      upload: ServerSettingsWireUploadView;
      // #324 — the deployment's HTTP host aliases; mediaLink admits an
      // upload link on any of them. Narrowed to string[] in userTopic.ts
      // (malformed / absent → []), threaded into applyServerSettings.
      http_host_aliases: string[];
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
  | { kind: "directory_failed"; network: string; reason: string }
  // #100 — transient upstream (re)connect indicator. PRESENTATIONAL ONLY:
  // "connecting" fires as a Session.Server (re)establishes the upstream
  // socket, "connected" on 001 RPL_WELCOME. cic mirrors it into a
  // per-network "reconnecting…" sidebar badge (reconnectingStatus.ts).
  // NOT the durable `connection_state` — that stays `connected` through a
  // transient reconnect; the badge is an ephemeral overlay. Rides the user
  // topic with the `network` slug discriminator (mirrors away_confirmed).
  | { kind: "connection_progress"; network: string; state: "connecting" | "connected" }
  // #581 — "recover my identity" guided recovery. Two transient user-topic
  // events, both carrying the network SLUG in `network`. `recover_progress`
  // is one step transition (identify → register → nick → recover → release,
  // each running → ok/failed); `recover_result` is the TERMINAL outcome. cic
  // mirrors them into the RecoverModal progress view (recoverProgress.ts) —
  // it NEVER originates recovery state; the first progress event opens the
  // modal, the result event concludes it. `reason` is cic-localized copy.
  | {
      kind: "recover_progress";
      network: string;
      step: RecoverStep;
      status: RecoverStatus;
      reason: string | null;
    }
  | {
      kind: "recover_result";
      network: string;
      outcome: RecoverOutcome;
      reason: string | null;
    }
  // #247 — /notify presence watch. `notify_list` is the full-list
  // snapshot broadcast on every Grappa.Notify mutation AND pushed on
  // user-topic after-join (same setState contract as
  // query_windows_list). `presence_changed` is one live report:
  // `initial: true` = post-arm baseline (paint the dot, NO toast),
  // `initial: false` = genuine transition (toast-eligible).
  // `presence_snapshot` re-paints the whole per-network dot map on
  // (re)attach; its keys are SERVER-side ASCII-folded nicks (A-Z only; #121/#525).
  // `presence_error` surfaces an upstream watch-list rejection
  // (ERR_MONLISTFULL / ERR_TOOMANYWATCH) — never a silent drop.
  | { kind: "notify_list"; networks: Record<string, NotifyEntry[]> }
  | {
      kind: "presence_changed";
      network_id: number;
      nick: string;
      presence: "online" | "offline";
      initial: boolean;
      source: "monitor" | "watch";
      ts: string;
    }
  | { kind: "presence_error"; network_id: number; reason: "list_full"; detail: string }
  | {
      kind: "presence_snapshot";
      network_id: number;
      nicks: Record<string, "online" | "offline" | "unknown">;
    }
  // #630 — inbound-flood web-session sever. When a client floods grappa
  // inbound, the server broadcasts this on the user topic, THEN revokes the
  // bearer + closes the socket. cic latches `severedForFlood` (floodSever.ts)
  // so the re-login screen shows a dedicated "disconnected for sending too
  // fast" banner. The arm reuses the generated `RateLimitWireWebSessionSevered
  // Event` shape DIRECTLY — equality holds by construction, so no `_Assert_`
  // pin is needed (same SSOT posture as the #410 leaf-enum aliases). `code`
  // is a closed single-value set ("rate_limit_flood") narrowed strictly at
  // ingress in userTopic.ts.
  | RateLimitWireWebSessionSeveredEvent;

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

// #428 — mirror of AdminEventsWireEvent; capacity_reject.flow kept tight (AdmissionFlow) until the server closes the atom() set (follow-up).
export type WireAdminEvent =
  | Exclude<AdminEventsWireEvent, { kind: "capacity_reject" }>
  | (Omit<Extract<AdminEventsWireEvent, { kind: "capacity_reject" }>, "flow"> & {
      flow: AdmissionFlow;
    });

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
// the server reply's SIBLING fields (limit, retry_after, …) — the
// redundant `error` key is dropped, since `code` already holds it (#112).
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
  // #112 — `code` is the token's home; strip the redundant `error` key so
  // `info` carries only the sibling fields callers actually branch on.
  const { error: _drop, ...info } = r;
  return new ChannelPushError(code, info);
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

// Exported so sibling REST clients (e.g. `themesApi.ts`) collapse wire
// error tokens to `ApiError.code` through the ONE decoder that also fires
// the shared 401 dead-token handler — duplicating it would silently skip
// the dead-token detection for those verbs.
//
// `fireDeadTokenHandler` (default true) gates ONLY the on401 side effect, not
// the decoding. THE RULE (#449, #502): pass `false` for boot-APPLIED cosmetic
// fetches — the ones a `mount*Sync` effect fires on EVERY token presence, whose
// failure mode is "the UI looks slightly wrong", NOT "the session is gone".
// Today that is the #449 display-prefs sync (`getDisplayPrefs`/`putDisplayPrefs`)
// and the #502 active-theme refresh (`getActiveThemePair`). Their transient 401
// must NEVER clear a valid session's token — they still throw the decoded
// `ApiError` so the caller keeps its boot cache, but they do not log the user
// out. Everything else keeps the default: session-validating GETs (`/me`) and
// on-demand user-action verbs, where a 401 genuinely means the token is dead.
// A NEW boot cosmetic fetch MUST pass `false`, or a flaky-connection 401 at
// boot will spuriously log the user out.
export async function readError(res: Response, fireDeadTokenHandler = true): Promise<ApiError> {
  if (res.status === 401 && fireDeadTokenHandler && on401Handler !== null) on401Handler();
  let body: Record<string, unknown> = {};
  let code: string;
  try {
    body = (await res.json()) as Record<string, unknown>;
    // Resolution order:
    //   1. `body.error` — the canonical A7 envelope shape used by every
    //      `FallbackController` arm (`{error: "<token>"}`), including
    //      the bucket-G-unified 422 `{error: "validation_failed",
    //      field_errors: ...}` shape. The body's SIBLING fields are
    //      captured into `info` (the redundant `error` key is dropped
    //      — it's lifted to `code`, #112) so callers can read
    //      `err.info.field_errors`, `err.info.site_key`, etc. without a
    //      second round-trip.
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
  // #112 — drop the redundant `error` key; `code` is its canonical home.
  const { error: _drop, ...info } = body;
  return new ApiError(res.status, code, info);
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

export async function verifyTotpLogin(
  challengeToken: string,
  code: string,
): Promise<AuthenticatedLoginResponse> {
  const res = await fetch("/auth/totp/verify", {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({ challenge_token: challengeToken, code }),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as AuthenticatedLoginResponse;
}

export async function getTotpStatus(token: string): Promise<{ enabled: boolean }> {
  const res = await fetch("/me/totp", { headers: buildHeaders(token) });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as { enabled: boolean };
}

export async function startTotpEnrollment(token: string): Promise<TotpEnrollment> {
  const res = await fetch("/me/totp/enrollment", {
    method: "POST",
    headers: buildHeaders(token),
    body: "{}",
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as TotpEnrollment;
}

export async function confirmTotpEnrollment(
  token: string,
  enrollmentToken: string,
  code: string,
): Promise<{ enabled: true; recovery_codes: string[] }> {
  const res = await fetch("/me/totp/enrollment/confirm", {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify({ enrollment_token: enrollmentToken, code }),
  });
  if (!res.ok) throw await readError(res, false);
  return (await res.json()) as { enabled: true; recovery_codes: string[] };
}

export async function disableTotp(token: string, password: string): Promise<void> {
  const res = await fetch("/me/totp", {
    method: "DELETE",
    headers: buildHeaders(token),
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw await readError(res, false);
}

async function passkeyRequest<T>(path: string, body: unknown, token?: string): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readError(res, false);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const getPasskeyLoginOptions = (identifier: string): Promise<PasskeyOptions> =>
  passkeyRequest<PasskeyOptions>("/auth/passkeys/options", { identifier });
export const verifyPasskeyLogin = (assertion: unknown): Promise<AuthenticatedLoginResponse> =>
  passkeyRequest<AuthenticatedLoginResponse>("/auth/passkeys/verify", assertion);
export const verifyPasskeySecondFactor = (
  assertion: unknown,
): Promise<AuthenticatedLoginResponse> =>
  passkeyRequest<AuthenticatedLoginResponse>("/auth/passkeys/second-factor", assertion);
export const recoverPasskeyLogin = (
  identifier: string,
  recoveryCode: string,
): Promise<AuthenticatedLoginResponse> =>
  passkeyRequest<AuthenticatedLoginResponse>("/auth/passkeys/recover", {
    identifier,
    recovery_code: recoveryCode,
  });

export type PasskeySummary = {
  id: string;
  name: string;
  inserted_at: string;
  last_used_at: string | null;
};
export type PasskeyStatus = {
  mode: "disabled" | "second_factor" | "passwordless";
  passkeys: PasskeySummary[];
};
export const getPasskeyStatus = async (token: string): Promise<PasskeyStatus> => {
  const res = await fetch("/me/passkeys", { headers: buildHeaders(token) });
  if (!res.ok) throw await readError(res);
  return await res.json();
};
export const startPasskeyRegistration = (
  token: string,
  password: string,
  name: string,
): Promise<PasskeyOptions> =>
  passkeyRequest<PasskeyOptions>("/me/passkeys/registration/options", { password, name }, token);
export const finishPasskeyRegistration = (
  token: string,
  credential: unknown,
): Promise<PasskeySummary> =>
  passkeyRequest<PasskeySummary>("/me/passkeys/registration", credential, token);
export const startPasskeyModeChange = (
  token: string,
  password: string,
  mode: "disabled" | "second_factor" | "passwordless",
): Promise<PasskeyOptions> =>
  passkeyRequest<PasskeyOptions>("/me/passkeys/mode/options", { password, mode }, token);
export const preparePasswordless = (
  token: string,
  password: string,
): Promise<{ recovery_codes: string[]; recovery_token: string }> =>
  passkeyRequest<{ recovery_codes: string[]; recovery_token: string }>(
    "/me/passkeys/passwordless/recovery",
    { password },
    token,
  );
export const startPasswordlessActivation = (
  token: string,
  recoveryToken: string,
): Promise<PasskeyOptions> =>
  passkeyRequest<PasskeyOptions>(
    "/me/passkeys/passwordless/options",
    { recovery_token: recoveryToken },
    token,
  );
export const finishPasskeyModeChange = (
  token: string,
  assertion: unknown,
): Promise<{ mode: string }> =>
  passkeyRequest<{ mode: string }>("/me/passkeys/mode", assertion, token);
export async function deletePasskey(token: string, id: string, password: string): Promise<void> {
  const res = await fetch(`/me/passkeys/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: buildHeaders(token),
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw await readError(res, false);
}

export async function me(token: string): Promise<MeResponse> {
  const res = await fetch("/me", {
    headers: buildHeaders(token),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as MeResponse;
}

// #211 phase 7 — `PATCH /me/identity` + its `IdentityResponse` are RETIRED.
// Visitor identity editing is per-network now via `updateNetworkIdentity`
// below (the subject-agnostic `PATCH /networks/:slug/identity` door), the
// same door users use.

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
export type AdminLiveState = LiveIntrospectionAdminWireLiveStateJson;

export type AdminVisitorLiveState = AdminLiveState;

// #211 phase 7 — per-network entry inside an AdminVisitor. A visitor is
// multi-network; each attached network carries its own nick +
// connection_state + live_state (`null` = the U-0 honesty signal). Mirror
// of `Grappa.Visitors.AdminWire.network_json/0`.
export type AdminVisitorNetwork = VisitorsAdminWireNetworkJson;

// #211 phase 7 — the admin visitor row is identity-wide + a per-network
// list (was flat `{nick, network_slug, live_state}`). `identified` derives
// server-side from the credentials (any network holds a NickServ secret).
export type AdminVisitor = VisitorsAdminWireT;

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

export type AdminSession = LiveIntrospectionAdminWireT;

export type AdminSessionsResponse = { sessions: AdminSession[] };

// Composite session id constructor — single source for the wire
// shape. Mirrors the server-side parse_session_id/1 in
// `lib/grappa_web/controllers/admin/sessions_controller.ex`.
export function adminSessionId(s: AdminSession): string {
  return `${s.subject_kind}:${s.subject_id}:${s.network_id}`;
}

// #269 — composite session id for a Visitors-tab per-network row. Same
// wire shape as `adminSessionId` (mirrors `parse_session_id/1`), but built
// from the identity-wide visitor id + the per-network `network_id` FK
// (the Visitors tab has no flat AdminSession row). Drives the per-network
// Disconnect ⇄ Reconnect toggle through `/admin/sessions/:id/{disconnect,reconnect}`.
export function adminVisitorSessionId(v: AdminVisitor, net: AdminVisitorNetwork): string {
  return `visitor:${v.id}:${net.network_id}`;
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

// #269 — Reconnect half of the admin Visitors-tab toggle. Sibling of
// `adminDisconnectSession`; POSTs to the visitor-only
// `/admin/sessions/:id/reconnect` verb (server reuses
// SessionPlan.resolve → SpawnOrchestrator.spawn). 204 on success
// (idempotent on an already-live session); errors collapse to ApiError.
export async function adminReconnectSession(token: string, id: string): Promise<void> {
  const res = await fetch(`/admin/sessions/${encodeURIComponent(id)}/reconnect`, {
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

// #215 — admin Session Log tab. Snapshot fetch of the persisted
// session-lifecycle log (`GET /admin/session_log`), newest-first,
// mirror of `Grappa.SessionLog.Wire.list_result/0`
// (`{session_log: SessionLogWireT[]}`). `limit` maps to the `?limit=N`
// query param (server default 200). Rows trust the server, same as the
// sibling `adminList*` helpers; the live `session_log_event` push on the
// admin channel (consumed by `lib/sessionLog.ts`) is the narrowed path.
export type AdminSessionLogEntry = SessionLogWireT;

export async function adminListSessionLog(
  token: string,
  limit?: number,
): Promise<SessionLogWireT[]> {
  const url = limit === undefined ? "/admin/session_log" : `/admin/session_log?limit=${limit}`;
  const res = await fetch(url, { headers: buildHeaders(token) });
  if (!res.ok) throw await readError(res);
  const body = (await res.json()) as SessionLogWireListResult;
  return body.session_log;
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

export type AdminCircuitState = Omit<AdmissionNetworkCircuitAdminWireT, "state"> & {
  state: AdminCircuitStateKind;
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

export type AdminNetwork = NetworksAdminWireT & {
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

// #228 — admin vhost (source-bind) CRUD + per-subject grants. Mirror of
// `GrappaWeb.Admin.VhostsController` GET/POST/PATCH/DELETE `/admin/vhosts`
// (+ the nested `/admin/vhosts/:id/grants` + `/admin/vhosts/grants/:grant_id`
// routes). Shapes match `Grappa.Vhosts.AdminWire.t()` server-side.
//
// A vhost is a host-bindable source address the operator makes available.
// `in_pool` = eligible for the round-robin "pool" a subject can multi-select;
// `generally_available` = offered to EVERY subject (vs. reachable only via an
// explicit grant). A grant makes a vhost self-selectable by one subject —
// availability-only (#251: the admin hard-pin was removed; the user always
// decides selection). `host_candidates` are the host's bindable IP literals
// (loopback/link-local pre-filtered) the admin picks from when creating a vhost.
export type AdminVhost = VhostsAdminWireVhostJson;

export type AdminVhostGrant = Omit<VhostsAdminWireGrantJson, "subject_type"> & {
  subject_type: "user" | "visitor";
};

export type AdminVhostsResponse = {
  vhosts: AdminVhost[];
  grants: AdminVhostGrant[];
  host_candidates: string[];
};

export type AdminVhostCreate = {
  address: string;
  in_pool?: boolean;
  generally_available?: boolean;
};

export type AdminVhostPatch = {
  address?: string;
  in_pool?: boolean;
  generally_available?: boolean;
};

export type AdminVhostGrantCreate = {
  subject_type: "user" | "visitor";
  subject_id: string;
};

// Returns the whole envelope — the caller needs vhosts + grants +
// host_candidates together (grants filter by vhost_id client-side; the
// create form's address `<select>` is populated from host_candidates).
export async function adminListVhosts(token: string): Promise<AdminVhostsResponse> {
  const res = await fetch("/admin/vhosts", { headers: buildHeaders(token) });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as AdminVhostsResponse;
}

export async function adminCreateVhost(token: string, body: AdminVhostCreate): Promise<AdminVhost> {
  const res = await fetch("/admin/vhosts", {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as AdminVhost;
}

export async function adminPatchVhost(
  token: string,
  id: number,
  body: AdminVhostPatch,
): Promise<AdminVhost> {
  const res = await fetch(`/admin/vhosts/${encodeURIComponent(String(id))}`, {
    method: "PATCH",
    headers: buildHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as AdminVhost;
}

export async function adminDeleteVhost(token: string, id: number): Promise<void> {
  const res = await fetch(`/admin/vhosts/${encodeURIComponent(String(id))}`, {
    method: "DELETE",
    headers: buildHeaders(token),
  });
  if (!res.ok) throw await readError(res);
}

export async function adminGrantVhost(
  token: string,
  id: number,
  body: AdminVhostGrantCreate,
): Promise<AdminVhostGrant> {
  const res = await fetch(`/admin/vhosts/${encodeURIComponent(String(id))}/grants`, {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as AdminVhostGrant;
}

export async function adminRevokeVhostGrant(token: string, grantId: number): Promise<void> {
  const res = await fetch(`/admin/vhosts/grants/${encodeURIComponent(String(grantId))}`, {
    method: "DELETE",
    headers: buildHeaders(token),
  });
  if (!res.ok) throw await readError(res);
}

// #257 — subject autocomplete backing the grant form. Read-only search
// over BOTH users + visitors → a tagged union. `type` maps 1:1 onto the
// grant body `subject_type`; `id` (the STABLE user id / visitor id, never
// a nick) → `subject_id`. `network` disambiguates a multi-network visitor
// ("network - nick"); it is null for a user (no single network). Nests
// under `/admin/vhosts/` so it rides the existing nginx allowlist alt (no
// proxy change). Server shape: `Grappa.SubjectSearch.AdminWire`.
export type AdminSubjectSearchResult = Omit<SubjectSearchAdminWireResultJson, "type"> & {
  type: "user" | "visitor";
};

export type AdminSubjectSearchResponse = { results: AdminSubjectSearchResult[] };

export async function adminSearchVhostSubjects(
  token: string,
  q: string,
): Promise<AdminSubjectSearchResult[]> {
  const res = await fetch(`/admin/vhosts/subject_search?q=${encodeURIComponent(q)}`, {
    headers: buildHeaders(token),
  });
  if (!res.ok) throw await readError(res);
  return ((await res.json()) as AdminSubjectSearchResponse).results;
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
  // S15 — same generated upload shape as the WS `server_settings_changed`
  // event; the REST GET/PUT `/admin/settings` view and the push share
  // one drift-gated definition.
  upload: ServerSettingsWireUploadView;
};

export type AdminSettingsResponse = { settings: AdminSettingsView };

// PUT body shape — every key in `upload` is optional. Controller
// upserts only present keys (`apply_updates/1` per-key dispatch).
// Cic sends the full subtree on save to keep the payload trivial;
// the controller's tolerance keeps backward-compat with partial
// payloads.
export type AdminSettingsUpdate = {
  // S15 — the PUT body is a per-key-optional projection of the same
  // generated upload shape; `active_host?` inherits the closed set.
  upload?: Partial<ServerSettingsWireUploadView>;
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

// #211 phase 6 — the #126 `disconnectSession` / `reconnectSession`
// (`POST /session/{disconnect,reconnect}`) client verbs are RETIRED.
// Visitors carry a real per-network `connection_state` now, so they
// park/reconnect each network via `patchNetwork(t, slug, {...})` like
// users; global disconnect is the client-composed park-all in `quit.ts`.

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

// #693 — the gap probe. Mirror of `GrappaWeb.MessagesController.count/2`:
// how many rows sit after `afterId`, uncapped and with the same presence
// filter a fetch would apply.
//
// `listMessagesAfter` above cannot answer this. It returns at most one page,
// so a full page means "at least 200 more" — which is the same answer for a
// 201-row gap (drain it, the operator barely notices) and a 3000-row one
// (abandon the anchor, the operator wants the present). The resume paths in
// `scrollback.ts` need to tell those apart, so they ask.
//
// Throws like its siblings on a non-2xx. Callers treat a throw as "unknown
// gap" and keep the pre-#693 cursor-anchored resume — an older server has no
// such route, and a client that hard-failed on that would be worse than one
// that degrades.
export async function countMessagesAfter(
  token: string,
  networkSlug: string,
  channelName: string,
  afterId: number,
): Promise<number> {
  const res = await fetch(
    `/networks/${encodeURIComponent(networkSlug)}/channels/${encodeURIComponent(channelName)}/messages/count?after=${afterId}`,
    { headers: buildHeaders(token) },
  );
  if (!res.ok) throw await readError(res);
  const body = (await res.json()) as { count: number };
  return body.count;
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
//
// #640 — `ctcpTarget` turns this into a CTCP QUERY send (/ctcp, /ping): the
// URL `channelName` is the SOURCE window the echo renders in, and `ctcpTarget`
// is the wire recipient. The server persists the echo to the source window
// (NOT a query window for the recipient) and relays the frame to `ctcpTarget`.
// Absent (a plain PRIVMSG) the POST body is unchanged, so every non-CTCP
// caller is byte-identical to the pre-#640 request.
export async function sendMessage(
  token: string,
  networkSlug: string,
  channelName: string,
  body: string,
  ctcpTarget?: string,
): Promise<ScrollbackMessage> {
  const payload = ctcpTarget === undefined ? { body } : { body, ctcp_target: ctcpTarget };
  const res = await fetch(
    `/networks/${encodeURIComponent(networkSlug)}/channels/${encodeURIComponent(channelName)}/messages`,
    {
      method: "POST",
      headers: buildHeaders(token),
      body: JSON.stringify(payload),
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
export type ArchiveEntry = ScrollbackWireArchiveWireEntry;

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

// #247 — /notify watch-list REST surface
// (`GrappaWeb.NotifyController`). Mutations only: cic's list + dot
// state arrive over the WS (`notify_list` snapshot broadcasts +
// `presence_snapshot` on attach), so the REST GET has no cic consumer
// — it exists server-side for API completeness and is deliberately
// NOT mirrored here (review 2026-07-19 R4 removed the dead client).

export async function postNotifyAdd(
  token: string,
  networkSlug: string,
  nicks: string[],
): Promise<void> {
  const res = await fetch(`/networks/${encodeURIComponent(networkSlug)}/notify`, {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify({ nicks }),
  });
  if (!res.ok) throw await readError(res);
}

export async function deleteNotifyNick(
  token: string,
  networkSlug: string,
  nick: string,
): Promise<void> {
  const res = await fetch(
    `/networks/${encodeURIComponent(networkSlug)}/notify/${encodeURIComponent(nick)}`,
    { method: "DELETE", headers: buildHeaders(token) },
  );
  if (!res.ok) throw await readError(res);
}

// #356 — the `clearNotify` REST client (for the dropped `/notify clear`
// subverb) was removed: presence removal is now per-entry (the settings ×
// → deleteNotifyNick). The server DELETE-all route stays (the e2e cleanup
// hits it via a raw fetch), but cic has no client for it.

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

export type CredentialJson = NetworksWireCredentialJson;

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

// #211 phase 4c/6 — visitor multi-network ACCRETION: attach + spawn an
// additional `visitor_enabled` network onto the authenticated visitor
// identity (`POST /session/networks`). Any visitor (anon OR registered)
// may call it (ruling C). The home page's "available to connect" section
// drives this; 204 on success. Errors (403 not-enabled, 409
// already-attached, 503 cap/circuit) surface via the usual envelope.
export async function addNetwork(token: string, networkSlug: string): Promise<void> {
  const res = await fetch("/session/networks", {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify({ network: networkSlug }),
  });
  if (!res.ok) throw await readError(res);
}

// #211 phase 6 (ruling E, subsumes original #211) — per-network IRC
// identity edit (nick/ident/realname) for BOTH subjects, live-applied
// server-side via an internal reconnect (`PATCH /networks/:slug/identity`).
// Returns the updated credential JSON. 422 on a bad nick / folded-nick
// collision; 404 if the caller holds no credential on the network.
export async function updateNetworkIdentity(
  token: string,
  networkSlug: string,
  fields: { nick?: string; ident?: string; realname?: string },
): Promise<CredentialJson> {
  const res = await fetch(`/networks/${encodeURIComponent(networkSlug)}/identity`, {
    method: "PATCH",
    headers: buildHeaders(token),
    body: JSON.stringify(fields),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as CredentialJson;
}

// #189 / #509 — per-network on-connect perform list. `perform_list` is the raw
// command list (one IRC line per line; null when unset); `oper_pass_set` /
// `nickserv_pass_set` report whether the WRITE-ONLY `$oper_pass` /
// `$nickserv_pass` secrets are stored — the secrets themselves are never
// returned. There is no live verb: an edit persists and takes effect on the
// next (re)connect.
export type PerformView = {
  perform_list: string | null;
  oper_pass_set: boolean;
  nickserv_pass_set: boolean;
};

export async function getPerform(token: string, networkSlug: string): Promise<PerformView> {
  const res = await fetch(`/networks/${encodeURIComponent(networkSlug)}/perform`, {
    headers: buildHeaders(token),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as PerformView;
}

// PUT the list + optional oper_pass / nickserv_pass. `perform_list: ""` clears
// the list; omitting a secret KEEPS the stored one (leave-blank-to-keep, like a
// password field), while `"<field>": ""` clears it. Echoes the same shape.
export async function putPerform(
  token: string,
  networkSlug: string,
  body: { perform_list?: string; oper_pass?: string; nickserv_pass?: string },
): Promise<PerformView> {
  const res = await fetch(`/networks/${encodeURIComponent(networkSlug)}/perform`, {
    method: "PUT",
    headers: buildHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as PerformView;
}

// ----- Admin-panel buckets 2-5 — REST CRUD wrappers -------------------
//
// Mirrors of the bucket-1/2/3 admin REST surface. All require an
// admin bearer token; visitor / non-admin sessions collapse to 403
// upstream (`:admin_authn`). Shapes match `Grappa.{Accounts,Networks,
// Networks.Servers,Networks.Credentials}.AdminWire.t()` server-side.

export type AdminUser = AccountsAdminWireT;

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

export type AdminServer = NetworksServersAdminWireT;

export type AdminServerCreate = {
  host: string;
  port: number;
  tls?: boolean;
  priority?: number;
  enabled?: boolean;
  // #266 — a bindable local IP literal to pin the outbound egress, or null to
  // leave unset. Server rejects a non-local literal with 422 source_not_local.
  source_address?: string | null;
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
export type FeaturedChannelLink = NetworksFeaturedChannelsWireLink;
export type FeaturedChannelsResponse = NetworksFeaturedChannelsWireIndexPayload;

// Admin shape — mirrors Grappa.Networks.FeaturedChannels.AdminWire.
export type AdminFeaturedChannel = NetworksFeaturedChannelsAdminWireT;

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

export type AdminCredential = NetworksCredentialsAdminWireT & {
  // Present on PUT responses only; index/GET shape excludes it.
  session_action?: NetworksCredentialsAdminWireSessionAction;
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
export type ShareTokenConsumeResponse = AuthenticatedLoginResponse;

export async function consumeShareToken(shareToken: string): Promise<ShareTokenConsumeResponse> {
  const res = await fetch("/auth/share/consume", {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify({ token: shareToken }),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as ShareTokenConsumeResponse;
}
