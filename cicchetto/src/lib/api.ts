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

export type LoginRequest = {
  identifier: string;
  password?: string;
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
export function displayNick(me: MeResponse): string {
  return me.kind === "user" ? me.name : me.nick;
}

// Mirror of `Grappa.Networks.Wire.network_json/0`. The integer `id` is
// the Ecto FK; the `slug` is the topic-vocabulary identifier — every
// REST URL takes `:network_id` as the slug, not the integer id.
export type Network = {
  id: number;
  slug: string;
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

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(`${status} ${code}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
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
  // The grappa server uses `%{error: "<token>"}` for tagged errors and
  // `%{errors: {detail: ...}}` for Phoenix's default 404/500 fallback —
  // try both before giving up. A non-JSON body collapses to the HTTP
  // status text so the caller still gets a useful `code`.
  try {
    const body = (await res.json()) as { error?: string; errors?: { detail?: string } };
    const code = body.error ?? body.errors?.detail ?? res.statusText;
    return new ApiError(res.status, code);
  } catch {
    return new ApiError(res.status, res.statusText || "unknown");
  }
}

export async function login(req: LoginRequest): Promise<LoginResponse> {
  const res = await fetch("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as LoginResponse;
}

export async function me(token: string): Promise<MeResponse> {
  const res = await fetch("/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as MeResponse;
}

export async function logout(token: string): Promise<void> {
  const res = await fetch("/auth/logout", {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw await readError(res);
}

export async function listNetworks(token: string): Promise<Network[]> {
  const res = await fetch("/networks", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as Network[];
}

export async function listChannels(token: string, networkSlug: string): Promise<ChannelEntry[]> {
  const res = await fetch(`/networks/${encodeURIComponent(networkSlug)}/channels`, {
    headers: { Authorization: `Bearer ${token}` },
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
    { headers: { Authorization: `Bearer ${token}` } },
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
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
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
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
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
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
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
      headers: { Authorization: `Bearer ${token}` },
    },
  );
  if (!res.ok) throw await readError(res);
}

// Mirror of `GrappaWeb.MembersJSON.index/1` — wire shape:
//   { "members": [{"nick": String, "modes": [String]}] }
// Already mIRC-sorted by `Session.list_members/3` (ops → voiced → plain,
// alphabetical within tier). cicchetto preserves that order.
export async function listMembers(
  token: string,
  networkSlug: string,
  channelName: string,
): Promise<{ nick: string; modes: string[] }[]> {
  const res = await fetch(
    `/networks/${encodeURIComponent(networkSlug)}/channels/${encodeURIComponent(channelName)}/members`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw await readError(res);
  const body = (await res.json()) as { members: { nick: string; modes: string[] }[] };
  return body.members;
}

// Mirror of `GrappaWeb.NickController.create/2`. Sends `NICK <new>`
// upstream through the session. The upstream replays the NICK back via
// `EventRouter`'s NICK handler which fans out per-channel `:nick_change`
// scrollback rows + reconciles `state.nick` server-side.
export async function postNick(token: string, networkSlug: string, nick: string): Promise<void> {
  const res = await fetch(`/networks/${encodeURIComponent(networkSlug)}/nick`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ nick }),
  });
  if (!res.ok) throw await readError(res);
}
