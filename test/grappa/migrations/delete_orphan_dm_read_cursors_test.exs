defmodule Grappa.Migrations.DeleteOrphanDmReadCursorsTest do
  @moduledoc """
  issue 2201 — the two data steps that drain the `read_cursors` rows a DM
  window does not own: the first (2026-09-15) for the cursors a closed window
  used to leave behind, the second for the ones written back after the close
  until `ReadCursor.set/4` started refusing that write. Same predicate, so the
  same tests run against both files.

  The first drain followed a code fix that made `QueryWindows.close/4` delete
  the cursor with the window. That fix did not stop new orphans: the pane's
  exit wrote the cursor back after the close, and 109 such rows were counted
  after it. The second drain follows the fix that refuses that write. Neither
  drain may assume a row count: the counts in issue 2201 (181 orphans over 27
  subjects on the re-measurement, which leaves `$server` out) describe the
  moment they were taken.

  What the tests pin, in the order the SQL can get them wrong:

    * an orphan DM cursor goes;
    * a DM cursor whose window still exists SURVIVES — including when the
      window is spelled at a different casing, because the match folds
      (a literal `=` would read `VJT` as no window for cursor `vjt` and
      delete a live read position);
    * a CHANNEL cursor survives — channels are not query windows and have no
      row to be orphaned from;
    * the `$server` pseudo-channel survives. It is nick-shaped by the sigil
      predicate and can NEVER have a `query_windows` row, so the ruling's
      "not `#&!+`" predicate alone would delete the server window's read
      position for every subject on the box;
    * the subject XOR holds — another subject's window does not rescue your
      cursor, and a VISITOR orphan goes;
    * a re-run is a no-op (cold deploys replay).

  `async: false`: `Ecto.Migrator.down/up` rewinds and replays a shared
  `schema_migrations` row, mirroring the `MoveLegacyServerPassToItsOwnSlot`
  precedent. The migration MODULE is executed — not a copy of its SQL pasted
  here — so this test fails if the shipped file is wrong.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{QueryWindows, Repo, ScrollbackHelpers, Visitors}

  # Matched by SUFFIX, not by version — a rebase renumbers the file and a
  # stale literal would make `Ecto.Migrator.down/4` answer `:already_down`,
  # i.e. a test that rewinds nothing and asserts against an untouched table.
  @migrations [
    {"first drain (2026-09-15)", "*_delete_orphan_dm_read_cursors.exs",
     Grappa.Repo.Migrations.DeleteOrphanDmReadCursors},
    {"second drain (refused writes)", "*_delete_dm_read_cursors_without_a_window.exs",
     Grappa.Repo.Migrations.DeleteDmReadCursorsWithoutAWindow}
  ]

  defp uniq, do: System.unique_integer([:positive])

  defp message(subject_attrs, net, channel, st) do
    {:ok, m} =
      ScrollbackHelpers.insert(
        Map.merge(subject_attrs, %{
          network_id: net.id,
          channel: channel,
          server_time: st,
          kind: :privmsg,
          sender: "peer",
          body: "m"
        })
      )

    m
  end

  # Raw INSERT so a cursor can be staged on any key the production write
  # boundary would fold or refuse (`$server`, a mixed-case leftover).
  defp seed_cursor(subject_attrs, net, channel, message_id) do
    ts = "2026-09-15T05:33:02.000000Z"

    Repo.query!(
      "INSERT INTO read_cursors (user_id, visitor_id, network_id, channel, last_read_message_id, inserted_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        subject_attrs[:user_id],
        subject_attrs[:visitor_id],
        net.id,
        channel,
        message_id,
        ts,
        ts
      ]
    )
  end

  defp channels_left(subject_attrs, net) do
    # Guarded on the id being PRESENT: the XOR shape carries BOTH keys, and an
    # unguarded `%{user_id: id}` clause matches a visitor subject with
    # `id = nil`, whose `WHERE user_id = NULL` then matches nothing and reads
    # as a cursor the migration removed.
    {col, id} =
      case subject_attrs do
        %{user_id: user_id} when is_binary(user_id) -> {"user_id", user_id}
        %{visitor_id: visitor_id} when is_binary(visitor_id) -> {"visitor_id", visitor_id}
      end

    %{rows: rows} =
      Repo.query!(
        "SELECT channel FROM read_cursors WHERE #{col} = ? AND network_id = ? ORDER BY channel",
        [id, net.id]
      )

    List.flatten(rows)
  end

  # The test DB is migrated at setup, so the version is already in
  # `schema_migrations` and a bare `up/4` answers `:already_up` — a call that
  # runs nothing and then asserts against untouched rows. Rewind, then replay.
  defp run_migration!({glob, module}) do
    path = migration_file!(glob)
    version = migration_version!(path)
    Code.require_file(path)
    assert :ok = Ecto.Migrator.down(Repo, version, module, log: false)
    assert :ok = Ecto.Migrator.up(Repo, version, module, log: false)
  end

  defp migration_file!(glob) do
    [path] = File.cwd!() |> Path.join("priv/repo/migrations/" <> glob) |> Path.wildcard()
    path
  end

  defp migration_version!(path) do
    path
    |> Path.basename()
    |> String.split("_", parts: 2)
    |> hd()
    |> String.to_integer()
  end

  setup do
    user = user_fixture()
    net = network_fixture()
    %{user: user, net: net, subject: %{user_id: user.id, visitor_id: nil}}
  end

  for {label, glob, module} <- @migrations do
    @glob glob
    @module module

    describe "#{label} — the orphans" do
      setup do: %{migration: {@glob, @module}}

      test "a DM cursor with no query window is deleted", ctx do
        m = message(%{user_id: ctx.user.id}, ctx.net, "ghost", 1)
        seed_cursor(ctx.subject, ctx.net, "ghost", m.id)

        assert channels_left(ctx.subject, ctx.net) == ["ghost"]

        run_migration!(ctx.migration)

        assert channels_left(ctx.subject, ctx.net) == []
      end

      test "a visitor's orphan DM cursor is deleted too", ctx do
        {:ok, visitor} =
          Visitors.find_or_provision_anon("v-2201-#{uniq()}", ctx.net.slug, "127.0.0.1")

        subject = %{user_id: nil, visitor_id: visitor.id}
        m = message(%{visitor_id: visitor.id}, ctx.net, "ghost", 1)
        seed_cursor(subject, ctx.net, "ghost", m.id)

        # Without this the assertion below is vacuous: a seed that never landed
        # reads the same as a row the migration removed.
        assert channels_left(subject, ctx.net) == ["ghost"]

        run_migration!(ctx.migration)

        assert channels_left(subject, ctx.net) == []
      end

      test "is idempotent — a second run changes nothing", ctx do
        m = message(%{user_id: ctx.user.id}, ctx.net, "ghost", 1)
        seed_cursor(ctx.subject, ctx.net, "ghost", m.id)
        keeper = message(%{user_id: ctx.user.id}, ctx.net, "#sniffo", 2)
        seed_cursor(ctx.subject, ctx.net, "#sniffo", keeper.id)

        run_migration!(ctx.migration)
        assert channels_left(ctx.subject, ctx.net) == ["#sniffo"]

        run_migration!(ctx.migration)
        assert channels_left(ctx.subject, ctx.net) == ["#sniffo"]
      end
    end

    describe "#{label} — what it must NOT touch" do
      setup do: %{migration: {@glob, @module}}

      test "a DM cursor whose query window still exists survives", ctx do
        m = message(%{user_id: ctx.user.id}, ctx.net, "vjt", 1)
        seed_cursor(ctx.subject, ctx.net, "vjt", m.id)
        {:ok, _} = QueryWindows.open({:user, ctx.user.id}, ctx.net.id, "vjt", ctx.user.name)

        run_migration!(ctx.migration)

        assert channels_left(ctx.subject, ctx.net) == ["vjt"]
      end

      test "the window match FOLDS: cursor 'vjt' is kept by a window spelled 'VJT'", ctx do
        m = message(%{user_id: ctx.user.id}, ctx.net, "vjt", 1)
        seed_cursor(ctx.subject, ctx.net, "vjt", m.id)
        {:ok, _} = QueryWindows.open({:user, ctx.user.id}, ctx.net.id, "VJT", ctx.user.name)

        run_migration!(ctx.migration)

        assert channels_left(ctx.subject, ctx.net) == ["vjt"]
      end

      test "a CHANNEL cursor survives with no window of any kind", ctx do
        m = message(%{user_id: ctx.user.id}, ctx.net, "#sniffo", 1)
        seed_cursor(ctx.subject, ctx.net, "#sniffo", m.id)

        run_migration!(ctx.migration)

        assert channels_left(ctx.subject, ctx.net) == ["#sniffo"]
      end

      test "the $server pseudo-channel survives — it can never have a window", ctx do
        m = message(%{user_id: ctx.user.id}, ctx.net, "$server", 1)
        seed_cursor(ctx.subject, ctx.net, "$server", m.id)

        run_migration!(ctx.migration)

        assert channels_left(ctx.subject, ctx.net) == ["$server"]
      end

      test "another subject's window does not rescue your cursor", ctx do
        other = user_fixture()
        m = message(%{user_id: ctx.user.id}, ctx.net, "vjt", 1)
        seed_cursor(ctx.subject, ctx.net, "vjt", m.id)
        # The window belongs to `other`, not to the cursor's subject.
        {:ok, _} = QueryWindows.open({:user, other.id}, ctx.net.id, "vjt", other.name)

        run_migration!(ctx.migration)

        assert channels_left(ctx.subject, ctx.net) == []
      end
    end
  end
end
