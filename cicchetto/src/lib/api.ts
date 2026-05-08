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

import { getOrCreateClientId } from "./clientId";

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
export type MeResponse =
  | { kind: "user"; id: string; name: string; inserted_at: string }
  | {
      kind: "visitor";
      id: string;
      nick: string;
      network_slug: string;
      expires_at: string;
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
// Resolution rules:
//   * visitor + matching network_slug → `me.nick` (the visitor IS the
//     IRC nick — visitors have one network only).
//   * visitor + other network         → `null` (visitors have no
//     credential row on networks they didn't log into).
//   * user + `net.nick` present       → `net.nick` (the per-credential
//     configured IRC nick, kept live by the `own_nick_changed`
//     user-topic event).
//   * user + `net.nick` absent        → `null` (a server contract
//     violation — `network_with_nick_to_json` REQUIRES non-empty nick
//     for user subjects; a missing one means a future server change
//     drifted from the wire spec). We log to `console.error` so the
//     drift is loud, and return null so the caller's null-branch
//     handles it — typically by skipping the join. The pre-fix
//     behavior was to fall back to `displayNick(me) === me.name`,
//     which silently DM-misrouted when account-name happened to
//     match a peer's IRC nick on the affected network.
//
// Use everywhere a per-network "own nick" comparison is made: the
// channels-loop self-JOIN/PART detection, the query-windows-loop
// own-nick skip, the DM-listener loop subscription topic, the
// ScrollbackPane self-highlight + mention-match.
export function ownNickForNetwork(net: Network, me: MeResponse | null | undefined): string | null {
  if (me == null) return null;
  if (me.kind === "visitor") {
    return me.network_slug === net.slug ? me.nick : null;
  }
  if (net.nick !== undefined && net.nick !== "") return net.nick;
  console.error(
    `ownNickForNetwork: user subject but Network.nick missing for slug=${net.slug} — server contract violation (network_with_nick_to_json should have populated it). Falling through to null; caller will skip topic join. Pre-fix this fell back to user.name and silently DM-misrouted when account-name matched a peer IRC nick. See codebase review 2026-05-08 cic H3.`,
  );
  return null;
}

// Mirror of `Grappa.Networks.Wire.network_json/0`. The integer `id` is
// the Ecto FK; the `slug` is the topic-vocabulary identifier — every
// REST URL takes `:network_id` as the slug, not the integer id.
export type Network = {
  id: number;
  slug: string;
  // nick is the per-network IRC nick as configured in the credential.
  // Populated for user subjects (GET /networks includes it); absent for
  // visitor subjects (visitors have no per-network credential row).
  nick?: string;
  inserted_at: string;
  updated_at: string;
};

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
  | "kick";

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

export type ChannelEvent = {
  kind: "message";
  message: ScrollbackMessage;
};

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
    };

// Exhaustiveness assertion for discriminated-union switches. If the
// switch handles every arm, the parameter type narrows to `never` at
// the default branch and `tsc` accepts the call. If a new arm is
// added without a handler, the parameter type widens away from
// `never` and `tsc` rejects — the build fails before the unhandled
// kind silently drops at runtime.
//
// Same pattern as `ScrollbackPane`'s exhaustive `MessageKind` switch
// (CP10 C3).
export function assertNever(x: never): never {
  throw new Error(`unreachable WireUserEvent variant: ${JSON.stringify(x)}`);
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

export async function listNetworks(token: string): Promise<Network[]> {
  const res = await fetch("/networks", {
    headers: buildHeaders(token),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as Network[];
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
// `{messages, next_cursor}` envelope; the cursor is `server_time` of the
// oldest row in the page (callers feed it back as `?before=`). Empty
// page = no more history.
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
