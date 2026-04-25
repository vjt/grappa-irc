defmodule GrappaWeb.Endpoint do
  @moduledoc """
  Phoenix endpoint — HTTP + WebSocket entry point under Bandit.

  Pipeline order matters: `RequestId` runs first so every downstream
  log line carries `[request_id]`; `Telemetry` straddles `Parsers` so
  request duration includes body decoding; `MethodOverride` runs
  after `Parsers` because it reads `_method` from the parsed body;
  `Plug.Head` lets HEAD share GET routes; `Session` runs before the
  router so handlers can call `get_session/2`.

  `signing_salt: "rotate-me"` is a Phase 1 placeholder. Cookies are
  not signed by any code path today (no auth flow, healthz is
  unauthenticated), but Phase 5 hardening must lift the salt to
  runtime config alongside `secret_key_base` so it is rotatable
  without a recompile.

  No `socket "/socket"` declaration yet — Phase 1 Task 6 wires
  `GrappaWeb.UserSocket` and the live channels.
  """
  use Phoenix.Endpoint, otp_app: :grappa

  @session_options [
    store: :cookie,
    key: "_grappa_key",
    signing_salt: "rotate-me",
    same_site: "Lax"
  ]

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
