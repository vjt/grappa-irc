defmodule Grappa.Repo.Migrations.AddIsAdminToUsers do
  @moduledoc """
  M-1 (admin-console cluster) — single-bit operator authorization flag
  on `users`. `false` by default; the first admin user is bootstrapped
  via `bin/grappa create-user --admin --name grappa --password <prompt>`
  (Q-FIRST-ADMIN), which
  ships in a later M bucket as a flag on the existing create-user verb.

  Subsequent M buckets layer `:admin` Phoenix pipeline +
  `require_admin/1` plug + the `/admin/*` endpoint family on top. Every
  authz gate downstream reads this column off the `%User{}` struct
  returned by `Accounts.get_user!/1`.

  DB-level `NOT NULL DEFAULT FALSE` so no row can carry SQL NULL —
  three-valued logic in authz checks is a footgun (a missing
  `is_admin` would silently bypass `require_admin/1` if any caller
  trusted `user.is_admin == true` semantics literally). Backfill is
  free: every existing row gets `false` from the default clause.
  """
  use Ecto.Migration

  def change do
    alter table(:users) do
      add :is_admin, :boolean, default: false, null: false
    end
  end
end
