defmodule GrappaWeb.Endpoint do
  @moduledoc """
  Phoenix endpoint — HTTP + WebSocket entry point under Bandit.

  Pipeline order matters: `RequestId` runs first so every downstream
  log line carries `[request_id]`; `Telemetry` straddles `Parsers` so
  request duration includes body decoding; `MethodOverride` runs
  after `Parsers` because it reads `_method` from the parsed body;
  `Plug.Head` lets HEAD share GET routes; `Session` runs before the
  router so handlers can call `get_session/2`.

  `signing_salt` is read from `:grappa, GrappaWeb.Endpoint,
  :session_signing_salt` via `Application.compile_env/3`. Phase 1
  shipped with the literal `"rotate-me"` placeholder hardcoded here;
  codebase audit web W10 + cross-infra L7 (same finding) flagged it.
  Today no app code calls `put_session/3` (no auth-cookie writes,
  healthz is unauthenticated), so the salt isn't load-bearing yet —
  but the placeholder was a smell + a footgun for the Phase 5
  hardening pass. Per-env default lives in `config/{dev,test}.exs`;
  prod operator MUST set `SECRET_SIGNING_SALT` (or the build fails to
  boot via `runtime.exs` raise).

  WebSocket transport at `/socket/websocket` is the only streaming
  surface. No longpoll fallback — Phase 1 clients are evergreen
  browsers, and the Phase 6 IRCv3 listener facade will need full
  WS framing anyway.
  """
  use Phoenix.Endpoint, otp_app: :grappa

  @session_options [
    store: :cookie,
    key: "_grappa_key",
    signing_salt: Application.compile_env!(:grappa, [__MODULE__, :session_signing_salt]),
    same_site: "Lax"
  ]

  socket "/socket", GrappaWeb.UserSocket,
    websocket: true,
    longpoll: false

  plug Plug.RequestId
  plug Plug.Telemetry, event_prefix: [:phoenix, :endpoint]

  plug Plug.Parsers,
    parsers: [:urlencoded, :multipart, :json],
    pass: ["*/*"],
    json_decoder: Phoenix.json_library()

  plug Plug.MethodOverride
  plug Plug.Head
  plug Plug.Session, @session_options
  plug GrappaWeb.Router
end
