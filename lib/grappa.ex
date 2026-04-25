defmodule Grappa do
  @moduledoc """
  grappa — an always-on IRC bouncer with REST + Phoenix Channels.

  See [`README.md`](https://github.com/vjt/grappa-irc/blob/main/README.md)
  and [`docs/DESIGN_NOTES.md`](https://github.com/vjt/grappa-irc/blob/main/docs/DESIGN_NOTES.md)
  for the architecture and design rationale.

  ## Top-level concepts

  Each is its own `Boundary` (see `mix boundary.spec`):

  - `Grappa.Bootstrap` — boot-time loader, reads `grappa.toml` and spawns sessions.
  - `Grappa.Config` — TOML config loader + struct definitions.
  - `Grappa.IRC` — own IRC client (parser + identifier validators + GenServer-owned socket).
  - `Grappa.Log` — canonical Logger metadata schema.
  - `Grappa.PubSub` — `Phoenix.PubSub` topic shape helpers.
  - `Grappa.Repo` — Ecto repo backed by sqlite.
  - `Grappa.Scrollback` — bouncer-owned scrollback storage with paginated reads + wire shape.
  - `Grappa.Session` — one supervised GenServer per `(user, network)` pair.
  - `GrappaWeb.Endpoint` — Phoenix HTTP + WebSocket Channels surface.

  Plus two internal-only boundaries — `Grappa.Application` (OTP
  callback module + supervision tree wiring) and `Grappa.Release`
  (release-shell migration tasks) — both `@moduledoc false`.
  """

  # `Grappa` is the namespace anchor + a tiny `version/0` helper. Each
  # sub-namespace under `Grappa.*` declares its own boundary with
  # `top_level?: true`, making them flat siblings rather than children
  # of this module's boundary — see Boundary's README "modules are
  # determined automatically from the boundary name."
  use Boundary, deps: [], exports: []

  @doc "Returns the current grappa version (compile-time, from `mix.exs`)."
  @spec version() :: String.t()
  def version do
    :grappa |> Application.spec(:vsn) |> to_string()
  end
end
