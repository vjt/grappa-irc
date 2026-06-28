defmodule Grappa.Repo.Migrations.FoldQueryWindowsTargetNickRfc1459 do
  @moduledoc """
  GH #121 — bring `query_windows` DM-target uniqueness to the SAME
  rfc1459 casemapping as the visitor lookups, so the whole server folds
  nicks one way ("total consistency or nothing").

  The two partial unique indexes were on `lower(target_nick)` — RFC 2812
  ASCII folding only. Azzurra (bahamut) is rfc1459: it ALSO folds
  `[ ] \\ ~` -> `{ } | ^`, so `foo[1]` and `foo{1}` are one DM target.
  Swap each index's expression from `lower(...)` to the rfc1459 fold (an
  expression index, like before — no denormalised column). The
  expression MUST stay character-identical to `Grappa.QueryWindows`'s
  on_conflict / lookup fragments and `Grappa.IRC.Identifier.nick_fold/1`,
  or SQLite stops recognising the query as index-eligible.

  ## Duplicate collapse

  The old `lower()` index already prevented ASCII-case dups, so only the
  new bracket-collisions (`foo[1]` vs `foo{1}` for one subject+network)
  could violate the rfc1459 index. Collapse them keeping `MAX(id)` (most
  recently opened) per `(subject, network_id, fold(target_nick))`. No-op
  on a fresh/test DB.

  ## Cold deploy

  New migration — must be cold-deployed (hot path skips ecto.migrate).
  """
  use Ecto.Migration

  # rfc1459 fold of a column expression, pure SQL. Self-contained (no
  # module dep — see FoldVisitorsNickUniqueIndex for the rationale).
  defp fold(col) do
    "replace(replace(replace(replace(lower(#{col}), '[', '{'), ']', '}'), '\\', '|'), '~', '^')"
  end

  def up do
    # Collapse rfc1459 bracket-collisions per subject branch before the
    # new unique index would reject them. COALESCE folds the XOR subject
    # into one grouping key; MAX(id) keeps the most recently opened row.
    execute("""
    DELETE FROM query_windows
    WHERE id NOT IN (
      SELECT MAX(id)
      FROM query_windows
      GROUP BY COALESCE(user_id, ''), COALESCE(visitor_id, ''), network_id, #{fold("target_nick")}
    )
    """)

    drop unique_index(:query_windows, ["user_id", "network_id", "lower(target_nick)"],
           name: :query_windows_user_network_nick_lower_index
         )

    drop unique_index(:query_windows, ["visitor_id", "network_id", "lower(target_nick)"],
           name: :query_windows_visitor_network_nick_lower_index
         )

    create unique_index(:query_windows, ["user_id", "network_id", "#{fold("target_nick")}"],
             name: :query_windows_user_network_nick_folded_index,
             where: "user_id IS NOT NULL"
           )

    create unique_index(:query_windows, ["visitor_id", "network_id", "#{fold("target_nick")}"],
             name: :query_windows_visitor_network_nick_folded_index,
             where: "visitor_id IS NOT NULL"
           )
  end

  def down do
    drop unique_index(:query_windows, ["user_id", "network_id", "#{fold("target_nick")}"],
           name: :query_windows_user_network_nick_folded_index
         )

    drop unique_index(:query_windows, ["visitor_id", "network_id", "#{fold("target_nick")}"],
           name: :query_windows_visitor_network_nick_folded_index
         )

    create unique_index(:query_windows, ["user_id", "network_id", "lower(target_nick)"],
             name: :query_windows_user_network_nick_lower_index,
             where: "user_id IS NOT NULL"
           )

    create unique_index(:query_windows, ["visitor_id", "network_id", "lower(target_nick)"],
             name: :query_windows_visitor_network_nick_lower_index,
             where: "visitor_id IS NOT NULL"
           )
  end
end
