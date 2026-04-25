defmodule Grappa do
  @moduledoc """
  grappa — an always-on IRC bouncer with REST + Phoenix Channels.

  See [`README.md`](https://github.com/vjt/grappa-irc/blob/main/README.md)
  and [`docs/DESIGN_NOTES.md`](https://github.com/vjt/grappa-irc/blob/main/docs/DESIGN_NOTES.md)
  for the architecture and design rationale.

  ## Top-level concepts

  - `Grappa.Config` — runtime TOML config loader.
  - `Grappa.Repo` — Ecto repo backed by sqlite.
  - `Grappa.Scrollback` — bouncer-owned scrollback storage with paginated reads.
  - `Grappa.IRC` — own IRC client implementation (parser + GenServer-owned socket).
  - `Grappa.Session` — one supervised GenServer per `(user, network)` pair.
  - `GrappaWeb.Endpoint` — Phoenix HTTP + WebSocket Channels surface.
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
