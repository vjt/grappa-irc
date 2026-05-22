defmodule GrappaWeb.Endpoint do
  @moduledoc """
  Phoenix endpoint — HTTP + WebSocket entry point under Bandit.

  Pipeline order matters: `RequestId` runs first so every downstream
  log line carries `[request_id]`; `Telemetry` straddles `Parsers` so
  request duration includes body decoding; `MethodOverride` runs
  after `Parsers` because it reads `_method` from the parsed body;
  `Plug.Head` lets HEAD share GET routes; `Session` runs before the
  router so handlers can call `get_session/2`.

  ## Session signing-salt runtime resolution (REV-C / H21)

  `signing_salt` is read at RUNTIME from `:grappa,
  GrappaWeb.Endpoint, :session_signing_salt`. Pre-REV-C the value was
  read at COMPILE time via `Application.compile_env!/2`, which baked
  the build-time `SECRET_SIGNING_SALT` env value into the prod
  release; an operator rotating the salt via `.env` + auto-deploy
  saw no effect until the image was rebuilt with a fresh `mix
  compile`. H21 moves the read to `config/runtime.exs` alongside
  `SECRET_KEY_BASE` so rotation works the same way as the sibling
  key — bump value, COLD-deploy, salt picks up at boot.

  The runtime read is cached in `:persistent_term` on first request
  (lazy init in the `session/2` plug). Subsequent requests are
  lock-free reads. Per CLAUDE.md "Application.{put,get}_env: boot-
  time only" — this is the boundary site for the keyspace; the rest
  of the codebase never sees the raw env value. First-request races
  are benign (multiple writers, same value).

  WebSocket transport at `/socket/websocket` is the only streaming
  surface. No longpoll fallback — Phase 1 clients are evergreen
  browsers, and the Phase 6 IRCv3 listener facade will need full
  WS framing anyway.
  """
  use Phoenix.Endpoint, otp_app: :grappa

  @session_key "_grappa_key"
  @session_persistent_term_key {__MODULE__, :session_opts}

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
  plug :session
  plug GrappaWeb.Router

  # Custom session plug that reads `signing_salt` at runtime from
  # `:grappa, __MODULE__, :session_signing_salt`. Cached after first
  # request — see moduledoc for the H21 rationale.
  defp session(conn, _) do
    Plug.Session.call(conn, cached_session_opts())
  end

  defp cached_session_opts do
    case :persistent_term.get(@session_persistent_term_key, nil) do
      nil ->
        salt =
          :grappa
          |> Application.fetch_env!(__MODULE__)
          |> Keyword.fetch!(:session_signing_salt)

        opts =
          Plug.Session.init(
            store: :cookie,
            key: @session_key,
            signing_salt: salt,
            same_site: "Lax"
          )

        :persistent_term.put(@session_persistent_term_key, opts)
        opts

      opts ->
        opts
    end
  end
end
