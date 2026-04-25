defmodule GrappaWeb.Endpoint do
  @moduledoc """
  Phoenix endpoint — HTTP + WebSocket entry point under Bandit.

  Pipeline order matters: `RequestId` runs first so every downstream
  log line carries `[request_id]`; `Telemetry` straddles the parser
  so request duration covers body decoding; `Plug.Head` lets HEAD
  share GET routes; `Session` stays last before the router because it
  reads cookies parsed by `Plug.Parsers`.

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
