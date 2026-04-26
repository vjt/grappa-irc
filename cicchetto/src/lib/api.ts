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
  name: string;
  password: string;
};

export type LoginResponse = {
  token: string;
  user: { id: string; name: string };
};

export type MeResponse = {
  id: string;
  name: string;
  inserted_at: string;
};

// Mirror of `Grappa.Networks.Wire.network_json/0`. The integer `id` is
// the Ecto FK; the `slug` is the topic-vocabulary identifier — every
// REST URL takes `:network_id` as the slug, not the integer id.
export type Network = {
  id: number;
  slug: string;
  inserted_at: string;
  updated_at: string;
};

// Mirror of `Grappa.Networks.Wire.channel_json/0`. Object envelope (not
// a bare string) is the Phase 5 extension point for joined/topic/unread.
export type ChannelEntry = {
  name: string;
};

// Mirror of `Grappa.Scrollback.Wire.t/0` + the `:event` push wrapper
// emitted by `GrappaWeb.GrappaChannel`. The push event name on the wire
// is literally `"event"`; the `kind` field discriminates the inner
// payload shape so future kinds (presence, topic-change) can land
// without changing the channel push contract.
export type MessageKind = "privmsg" | "notice" | "action";

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

async function readError(res: Response): Promise<ApiError> {
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
