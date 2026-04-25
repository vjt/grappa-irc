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

  @doc "Returns the current grappa version (compile-time, from `mix.exs`)."
  @spec version() :: String.t()
  def version do
    :grappa |> Application.spec(:vsn) |> to_string()
  end
end
