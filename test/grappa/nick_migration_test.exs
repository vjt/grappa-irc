defmodule Grappa.NickMigrationTest do
  @moduledoc """
  #1378 — the nick-rename migration set must not take SQLite's write lock to
  migrate nothing.

  ## The oracle, and why it is a savepoint and not `BEGIN IMMEDIATE`

  `Grappa.Repo.TransactionModeGateTest` establishes that the transaction MODE
  is undecidable at runtime: under the SQL Sandbox every test already runs
  inside a transaction, so `exqlite` collapses every mode to
  `SAVEPOINT exqlite_savepoint`. That argument does not reach THIS defect.
  Whether a transaction is opened AT ALL is perfectly decidable — the
  savepoint statement is emitted or it is not — and it is the same statement
  that, unsandboxed, is the `BEGIN IMMEDIATE` that took the lock. So the
  oracle counts transaction-control statements off Ecto's own query
  telemetry, and reads a savepoint as the sandbox's image of the write lock.

  The e2e half of the proof (the `busy_locked` fault disappearing from
  `issue458-presence-page-yield` under load) lives where load exists; this
  file owns the decision, deterministically and with no IRC in sight.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{DmConversations, DmConversationsHelpers}
  alias Grappa.IRC.Identifier
  alias Grappa.{NickMigration, QueryWindows, ReadCursor, Scrollback, ScrollbackHelpers}
  alias Grappa.Scrollback.Message
  alias Grappa.UserSettings

  # Every SQL statement THIS TEST CAUSED while `fun` runs, lowercased.
  #
  # `async: false` keeps concurrent tests out of the window, but it is not
  # sufficient and never was (issue 2064): `:telemetry.attach/4` is VM-global,
  # so an ambient process — a sweeper, a `Session.Server` — emits into this
  # list too, and shared mode means it does so on this very connection. One
  # stray transaction is enough to invert the oracle below, because a
  # savepoint this test did not cause reads exactly like the write lock it
  # exists to forbid. A handler runs INSIDE the emitting process, so
  # `self() == test` is the attribution; `$callers` is not consulted because
  # `peer_renamed/5` runs in the test process.
  defp capture_sql(fun) do
    ref = make_ref()
    test = self()

    :telemetry.attach(
      "nm-sql-#{inspect(ref)}",
      [:grappa, :repo, :query],
      fn _, _, %{query: query}, _ ->
        if self() == test, do: send(test, {ref, String.downcase(query)})
      end,
      nil
    )

    try do
      fun.()
    after
      :telemetry.detach("nm-sql-#{inspect(ref)}")
    end

    drain(ref, [])
  end

  defp drain(ref, acc) do
    receive do
      {^ref, query} -> drain(ref, [query | acc])
    after
      0 -> Enum.reverse(acc)
    end
  end

  defp transaction_statements(queries) do
    Enum.filter(queries, &(&1 =~ "savepoint" or String.starts_with?(&1, "begin")))
  end

  defp dm(net, user, channel, dm_with, sender) do
    {:ok, message} =
      Scrollback.persist_event(%{
        network_id: net.id,
        user_id: user.id,
        channel: channel,
        dm_with: dm_with,
        server_time: System.system_time(:millisecond),
        kind: :privmsg,
        sender: sender,
        body: "hi"
      })

    message
  end

  defp fk(message_id) do
    Message
    |> where([m], m.id == ^message_id)
    |> select([m], m.dm_conversation_id)
    |> Repo.one!()
  end

  describe "peer_renamed/5 opens no transaction when there is nothing to migrate" do
    test "a peer with no query window and no mute costs zero transaction statements" do
      user = user_fixture()
      net = network_fixture()
      subject = {:user, user.id}

      queries =
        capture_sql(fn ->
          assert {:ok, %{window: :noop, rows: 0, mute: :noop}} =
                   NickMigration.peer_renamed(subject, net.id, net.slug, "oldnick", "newnick")
        end)

      assert transaction_statements(queries) == [],
             "a rename with nothing to move opened a write transaction: " <>
               inspect(transaction_statements(queries))
    end

    test "the probe is the only reason it is cheap — a peer WITH a window still transacts" do
      # The complement, and the assertion that stops the fix from degrading
      # into "never transact": the real migration path must keep its
      # transaction, which is the whole atomicity contract.
      user = user_fixture()
      net = network_fixture()
      subject = {:user, user.id}
      {:ok, _} = QueryWindows.open(subject, net.id, "oldnick", user.name)

      queries =
        capture_sql(fn ->
          assert {:ok, %{window: :renamed}} =
                   NickMigration.peer_renamed(subject, net.id, net.slug, "oldnick", "newnick")
        end)

      refute transaction_statements(queries) == [],
             "the migration path lost its transaction"
    end
  end

  describe "peer_renamed/5 still migrates everything it used to" do
    test "a windowed peer moves window, DM history and cursor together" do
      user = user_fixture()
      net = network_fixture()
      subject = {:user, user.id}
      {:ok, _} = QueryWindows.open(subject, net.id, "oldnick", user.name)

      {:ok, _} =
        Scrollback.persist_event(%{
          network_id: net.id,
          user_id: user.id,
          channel: "oldnick",
          dm_with: "oldnick",
          server_time: System.system_time(:millisecond),
          kind: :privmsg,
          sender: "oldnick",
          body: "before the rename"
        })

      assert {:ok, %{window: :renamed, rows: rows}} =
               NickMigration.peer_renamed(subject, net.id, net.slug, "oldnick", "newnick")

      assert rows >= 1
      assert QueryWindows.exists?(subject, net.id, "newnick")
      refute QueryWindows.exists?(subject, net.id, "oldnick")
    end

    test "a windowless peer's MUTE still follows — the store that outlives the window" do
      # The reason the no-transaction path is not simply an early return: with
      # no window the mute is the one store that can still move, and #1340
      # migrates it UNCONDITIONALLY because a mute outlives the window it
      # silenced. A fix that skipped the whole call when no window exists
      # would strand exactly the mute nobody can see to fix.
      user = user_fixture()
      net = network_fixture()
      subject = {:user, user.id}
      old_key = Identifier.channel_key(net.slug, "oldnick")
      new_key = Identifier.channel_key(net.slug, "newnick")

      prefs = UserSettings.default_notification_prefs()

      {:ok, _} =
        UserSettings.put_notification_prefs(subject, %{
          prefs
          | muted_targets: %{old_key => %{"until" => nil}}
        })

      assert {:ok, %{window: :noop, mute: :renamed}} =
               NickMigration.peer_renamed(subject, net.id, net.slug, "oldnick", "newnick")

      # `get_notification_prefs/1` closes over ATOM keys — `merge_with_defaults/1`
      # rebuilds the map rather than returning the stored blob — so reaching for
      # the string key here silently reads `nil` off a map that does have the
      # mute. Asked with the string key, this assertion could only ever crash.
      muted = UserSettings.get_notification_prefs(subject).muted_targets
      assert Map.has_key?(muted, new_key)
      refute Map.has_key?(muted, old_key)
    end
  end

  describe "issue 1365 — the DM conversation follows exactly the rows that moved" do
    test "a rename with no collision is one UPDATE: same id, new display, still open" do
      user = user_fixture()
      net = network_fixture()
      subject = {:user, user.id}
      {:ok, _} = QueryWindows.open(subject, net.id, "oldnick", user.name)
      row = dm(net, user, "me", "oldnick", "oldnick")
      before = DmConversations.get(subject, net.id, "oldnick")

      assert {:ok, %{window: :renamed, conversation: :renamed}} =
               NickMigration.peer_renamed(subject, net.id, net.slug, "oldnick", "NewNick")

      after_rename = DmConversations.get(subject, net.id, "newnick")
      assert after_rename.id == before.id
      assert after_rename.peer_nick == "NewNick"
      assert after_rename.opened_at == before.opened_at
      assert DmConversations.get(subject, net.id, "oldnick") == nil
      assert fk(row.id) == before.id
      assert DmConversationsHelpers.divergent_message_ids() == []
    end

    test "a rename into a nick with a CLOSED conversation MERGES: children move, the loser is deleted" do
      user = user_fixture()
      net = network_fixture()
      subject = {:user, user.id}

      # The survivor: history with `newnick`, window closed — exactly the case
      # ruling T1 turned into a merge by making the index total.
      survivor_row = dm(net, user, "me", "newnick", "newnick")
      survivor = DmConversations.get(subject, net.id, "newnick")
      assert survivor.opened_at == nil

      {:ok, _} = QueryWindows.open(subject, net.id, "oldnick", user.name)
      loser_row = dm(net, user, "me", "oldnick", "oldnick")
      {:ok, _} = ReadCursor.set(subject, net.id, "oldnick", loser_row.id)
      loser = DmConversations.get(subject, net.id, "oldnick")

      assert {:ok, %{window: :renamed, conversation: :merged}} =
               NickMigration.peer_renamed(subject, net.id, net.slug, "oldnick", "newnick")

      assert DmConversations.get(subject, net.id, "oldnick") == nil
      refute Repo.get(DmConversations.Conversation, loser.id)

      merged = DmConversations.get(subject, net.id, "newnick")
      assert merged.id == survivor.id
      # The window moved onto the survivor, so the survivor is open now.
      assert %DateTime{} = merged.opened_at
      assert fk(loser_row.id) == survivor.id
      assert fk(survivor_row.id) == survivor.id
      assert ReadCursor.get(subject, net.id, "newnick").dm_conversation_id == survivor.id
      assert DmConversationsHelpers.divergent_message_ids() == []
    end

    test "a merge larger than one batch moves every row" do
      user = user_fixture()
      net = network_fixture()
      subject = {:user, user.id}
      _ = dm(net, user, "me", "newnick", "newnick")
      {:ok, _} = QueryWindows.open(subject, net.id, "oldnick", user.name)
      loser = DmConversations.get(subject, net.id, "oldnick")

      # 1,201 rows: two full batches of 500 and a partial one, so the loop's
      # continue AND stop arms both run. Seeded through the test helper and
      # attached by hand — persisting them one by one would test nothing more.
      for n <- 1..1_201 do
        {:ok, _} =
          ScrollbackHelpers.insert(%{
            user_id: user.id,
            network_id: net.id,
            channel: "me",
            dm_with: "oldnick",
            server_time: n,
            kind: :privmsg,
            sender: "oldnick",
            body: "row #{n}"
          })
      end

      Message
      |> where([m], m.dm_with == "oldnick")
      |> Repo.update_all(set: [dm_conversation_id: loser.id])

      assert {:ok, %{conversation: :merged}} =
               NickMigration.peer_renamed(subject, net.id, net.slug, "oldnick", "newnick")

      refute Message |> where([m], m.dm_conversation_id == ^loser.id) |> Repo.exists?()
      assert DmConversationsHelpers.divergent_message_ids() == []
    end

    test "an own-nick rename SPLITS a conversation that also holds a peer's history" do
      user = user_fixture()
      net = network_fixture()
      subject = {:user, user.id}

      # Before we took `oldme`, somebody else bore it and we DM'd them: an
      # outbound row keyed `oldme`, sent by us under another nick.
      peer_row = dm(net, user, "oldme", "oldme", "earlier")
      # Then we became `oldme` and wrote to ourselves: a self row, same key.
      self_row = dm(net, user, "oldme", "oldme", "oldme")
      shared = DmConversations.get(subject, net.id, "oldme")
      assert fk(peer_row.id) == shared.id
      assert fk(self_row.id) == shared.id

      assert {:ok, %{rows: 1, conversation: :split}} =
               NickMigration.own_renamed(subject, net.id, net.slug, "oldme", "newme")

      mine = DmConversations.get(subject, net.id, "newme")
      assert fk(self_row.id) == mine.id
      # The peer's history stays where its key says it lives.
      assert fk(peer_row.id) == shared.id
      assert DmConversations.get(subject, net.id, "oldme").id == shared.id
      assert DmConversationsHelpers.divergent_message_ids() == []
    end

    test "a windowless peer's rename moves no history, so the conversation stays put" do
      user = user_fixture()
      net = network_fixture()
      subject = {:user, user.id}
      row = dm(net, user, "me", "oldnick", "oldnick")
      before = DmConversations.get(subject, net.id, "oldnick")

      assert {:ok, %{window: :noop, conversation: :noop}} =
               NickMigration.peer_renamed(subject, net.id, net.slug, "oldnick", "newnick")

      assert DmConversations.get(subject, net.id, "oldnick").id == before.id
      assert DmConversations.get(subject, net.id, "newnick") == nil
      assert fk(row.id) == before.id
      assert DmConversationsHelpers.divergent_message_ids() == []
    end
  end
end
