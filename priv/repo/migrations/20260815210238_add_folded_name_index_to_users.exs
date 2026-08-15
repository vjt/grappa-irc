defmodule Grappa.Repo.Migrations.AddFoldedNameIndexToUsers do
  @moduledoc """
  #1353 — `users.name` is an identity KEY, so it folds like every other
  identity key in this schema: a UNIQUE expression index on
  `lower(name)`, with the column left RAW for display (the #121/#525
  key/display split, already carried by `network_credentials`,
  `query_windows` and `notify_entries`).

  The byte-exact `users_name_index` from `20260426000000` stays. It is
  implied by the folded one, and dropping it in the same migration that
  adds a stricter one buys nothing while removing the fallback if this
  index is ever rolled back.

  ## The fold is plain `lower()`

  `Grappa.Accounts.User`'s `@name_format` admits
  `[a-zA-Z][a-zA-Z0-9_-]*` and nothing else, so the entire legal charset
  is ASCII and `lower()` is byte-for-byte `Identifier.canonical_target/1`
  over it. The expression MUST stay character-identical to
  `Grappa.IRC.Identifier.nick_fold_sql/1` or SQLite will not use the
  index. Inlined rather than called: migrations stay self-contained,
  since they run under a possibly-truncated code load order.

  ## A collision REFUSES the migration — it does not resolve it

  The sibling folded-index migrations (`20260628100000`,
  `20260711131000`) collapse case-variant duplicates by deleting the
  losers before creating the index. That is right for a visitor
  credential: it is disposable, and the next login re-provisions it. It
  is wrong here. Two rows in `users` are two ACCOUNTS, each with a
  password, sessions, credentials, scrollback and themes hanging off it.
  Merging them silently would be data loss the operator never asked for
  and cannot see afterwards, and choosing a survivor is not a decision
  this file is entitled to make.

  So the check runs FIRST and raises, naming every colliding spelling,
  and the index is never created. The operator renames one side and runs
  the deploy again — an operator-action failure taking the loud path,
  the same posture as `Grappa.Networks.NoServerError`.

  ## Cold deploy

  A new migration: the hot path skips `ecto.migrate`, so this rides a
  COLD window.
  """
  use Ecto.Migration

  # The ASCII fold of `name`, in pure SQL. Written out rather than
  # derived so the literal is in the source where the #525 fold pin in
  # `Grappa.IRC.IdentifierTest` can compare it against
  # `Identifier.nick_fold_sql("name")` — one byte of drift reddens there.
  @folded_name "lower(name)"

  def up do
    refuse_on_collisions()

    create unique_index(:users, [@folded_name], name: :users_folded_name_index)
  end

  def down do
    drop unique_index(:users, [@folded_name], name: :users_folded_name_index)
  end

  # Every group of two or more accounts whose names differ only by case.
  # Raising here aborts the migration with the table untouched.
  defp refuse_on_collisions do
    %{rows: rows} =
      repo().query!("""
      SELECT group_concat(name, ', ')
      FROM users
      GROUP BY #{@folded_name}
      HAVING COUNT(*) > 1
      ORDER BY #{@folded_name}
      """)

    case rows do
      [] ->
        :ok

      collisions ->
        groups = Enum.map_join(collisions, "\n  ", fn [names] -> names end)

        raise """
        Cannot make users.name case-insensitively unique: \
        #{length(collisions)} group(s) of accounts differ only by case.

          #{groups}

        Each group is more than one account, with its own password,
        sessions, credentials and scrollback. This migration will not
        choose which one survives: rename all but one member of each
        group, then run the deploy again.
        """
    end
  end
end
