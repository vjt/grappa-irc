defmodule Grappa.Repo do
  @moduledoc """
  Ecto repository backed by sqlite via `ecto_sqlite3`.

  This is the SINGLE shared Repo for the bouncer — there is no per-user
  dynamic Repo, no `put_dynamic_repo` plumbing. The alternative was
  considered and rejected on coherence + plumbing-tax grounds; see
  `docs/DESIGN_NOTES.md` (2026-04-25 single-sqlite sub-decision) for
  the full reasoning. Resist the urge to introduce dynamic Repos.
  """
  use Ecto.Repo,
    otp_app: :grappa,
    adapter: Ecto.Adapters.SQLite3
end
