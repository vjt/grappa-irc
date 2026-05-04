defmodule Grappa.Repo.Migrations.CreateQueryWindows do
  @moduledoc """
  Creates the `query_windows` table — persisted per-user open DM (query)
  windows for the channel-client-polish cluster.

  ## Purpose

  cicchetto renders DM windows for active IRC queries. Without persistence
  the window list resets on every page reload or device switch. This table
  lets `Grappa.QueryWindows.open/3` / `close/3` / `list_for_user/1`
  maintain the open set server-side; the C-side buckets consume it via
  Phoenix Channels snapshot on join.

  ## Schema design

    * `user_id` → `users.id` ON DELETE CASCADE — user deleted = all their
      windows gone, no orphan cleanup needed.
    * `network_id` → `networks.id` ON DELETE CASCADE — network deleted (or
      last credential unbound + cascade triggered) = those DM windows gone.
      Visitor session ephemeral cleanup rides the credential cascade.
    * `target_nick` — case-preserving as stored. IRC nicks are
      case-insensitive by protocol so the unique index uses `lower()`.
    * `opened_at` — first-opened timestamp. The upsert intentionally does
      NOT update this on a duplicate call ("first opened" semantics give
      the user a stable ordering anchor that doesn't reset on re-open).

  ## Composite unique index: `lower(target_nick)`

  SQLite supports expression-based indexes natively. Ecto's `create
  unique_index/3` DSL doesn't expose the expression form for sqlite
  (it would compile to `CREATE UNIQUE INDEX ... ON ... (lower(target_nick))`
  which sqlite accepts but Ecto can't generate), so we use `execute/1`
  directly — the same strategy used in this codebase for other
  sqlite-specific index shapes.

  The application-layer query (`Grappa.QueryWindows.close/3` and the
  idempotent re-select in `open/3`) also uses `lower()` so the index
  is always hit.

  ## No auto-prune

  Spec is explicit: no background reaper. Rows are removed when the user
  explicitly closes a window (`/q` or clicking the window close button)
  or when the parent user/network row cascades on delete.
  """
  use Ecto.Migration

  def change do
    create table(:query_windows) do
      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      add :network_id, references(:networks, on_delete: :delete_all), null: false
      add :target_nick, :string, null: false
      add :opened_at, :utc_datetime, null: false

      timestamps(type: :utc_datetime)
    end

    # Plain indexes for FK lookup performance (cascade deletes + list queries)
    create index(:query_windows, [:user_id])
    create index(:query_windows, [:network_id])

    # Case-insensitive composite uniqueness: one DM window per
    # (user, network, nick-case-folded). Ecto's DSL can't express
    # expression indexes for sqlite so we drop to execute/1.
    execute(
      "CREATE UNIQUE INDEX query_windows_user_network_nick_lower_index ON query_windows (user_id, network_id, lower(target_nick))",
      "DROP INDEX IF EXISTS query_windows_user_network_nick_lower_index"
    )
  end
end
