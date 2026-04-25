defmodule Grappa.Repo do
  @moduledoc """
  Ecto repository backed by sqlite via `ecto_sqlite3`.

  See `docs/DESIGN_NOTES.md` (2026-04-25 single sqlite sub-decision)
  for why this is one shared Repo and not per-user.
  """
  use Ecto.Repo,
    otp_app: :grappa,
    adapter: Ecto.Adapters.SQLite3
end
