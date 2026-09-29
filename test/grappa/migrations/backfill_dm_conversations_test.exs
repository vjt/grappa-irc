defmodule Grappa.Migrations.BackfillDmConversationsTest do
  @moduledoc """
  issue 1365 leg 1 — the backfill that mints `dm_conversations` for the DM
  history that predates the table and points every existing DM row at it.

  The fixture fabricates, by hand, every class the orchestrator's census of a
  frozen prod copy named (2026-09-28): tagged history (class A, `dm_with`
  set), legacy untagged DM rows (class B), conversations that exist ONLY as
  an open window (class D), the `$server` rows that are 98.5% of the
  unsigilled bucket (the trap), channel rows, a visitor with the same peer
  as the user, and a DM cursor whose key has no other source.

  What is pinned, in the order the SQL can get it wrong:

    * the mint count is exactly the distinct DM keys of all four sources;
    * every DM row points at the conversation its key names, and nothing
      else points anywhere (`DmConversationsHelpers.divergent_message_ids/0`
      — an SQL oracle independent of this migration, whose negative control
      lives in `Grappa.DmConversationsTest`);
    * open state mirrors `query_windows`, spelling prefers the window;
    * the subject XOR holds;
    * a second run over a partially attached table converges to the same
      state (the committed-prefix resume a batched run relies on).

  🔴 **Correctness only.** This proves WHAT the backfill writes on a
  fabricated database. It says nothing about how long it takes on prod's
  5,201,283 rows — that is not measured.

  `async: false`: `Ecto.Migrator.down/up` rewinds and replays a shared
  `schema_migrations` row. The migration MODULE is executed, not a copy of
  its SQL.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.DmConversations.Conversation
  alias Grappa.DmConversationsHelpers
  alias Grappa.{QueryWindows, ScrollbackHelpers}
  alias Grappa.ReadCursor.Cursor
  alias Grappa.Scrollback.Message

  # Matched by SUFFIX, not by version — a rebase renumbers the file.
  @migration_glob "priv/repo/migrations/*_backfill_dm_conversations.exs"

  defp run_migration! do
    assert :ok = Ecto.Migrator.down(Repo, migration_version!(), load_migration!(), log: false)
    assert :ok = Ecto.Migrator.up(Repo, migration_version!(), load_migration!(), log: false)
  end

  # Replays `up/0` WITHOUT `down/0` in front of it: forget the version, run
  # again. The only way to put the migration in front of a table it already
  # (partly) wrote, which is what a re-run after a crash sees.
  defp rerun_up! do
    Repo.query!("DELETE FROM schema_migrations WHERE version = ?", [migration_version!()])
    assert :ok = Ecto.Migrator.up(Repo, migration_version!(), load_migration!(), log: false)
  end

  defp load_migration! do
    Code.require_file(migration_file!())
    Grappa.Repo.Migrations.BackfillDmConversations
  end

  defp migration_file! do
    [path] = File.cwd!() |> Path.join(@migration_glob) |> Path.wildcard()
    path
  end

  defp migration_version! do
    migration_file!()
    |> Path.basename()
    |> String.split("_", parts: 2)
    |> hd()
    |> String.to_integer()
  end

  defp row(subject_attrs, net, channel, dm_with, sender, kind) do
    {:ok, m} =
      ScrollbackHelpers.insert(
        Map.merge(subject_attrs, %{
          network_id: net.id,
          channel: channel,
          dm_with: dm_with,
          server_time: System.unique_integer([:positive, :monotonic]),
          kind: kind,
          sender: sender,
          body: "m"
        })
      )

    m
  end

  defp seed_cursor(subject_attrs, net, channel, message_id) do
    ts = "2026-09-29T00:00:00.000000Z"

    Repo.query!(
      "INSERT INTO read_cursors (user_id, visitor_id, network_id, channel, last_read_message_id, inserted_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [subject_attrs[:user_id], subject_attrs[:visitor_id], net.id, channel, message_id, ts, ts]
    )
  end

  defp conversations do
    Conversation |> order_by([c], [c.user_id, c.visitor_id, c.peer_nick]) |> Repo.all()
  end

  defp by_key(subject_col, subject_id) do
    conversations()
    |> Enum.filter(&(Map.fetch!(&1, subject_col) == subject_id))
    |> Map.new(&{String.downcase(&1.peer_nick), &1})
  end

  defp fk_of(%Message{id: id}) do
    Message
    |> where([m], m.id == ^id)
    |> select([m], m.dm_conversation_id)
    |> Repo.one!()
  end

  defp cursor_fk(net, channel) do
    Cursor
    |> where([c], c.network_id == ^net.id and c.channel == ^channel)
    |> select([c], c.dm_conversation_id)
    |> Repo.one!()
  end

  defp snapshot do
    %{
      conversations: Enum.map(conversations(), &Map.take(&1, [:id, :user_id, :visitor_id, :peer_nick, :opened_at])),
      message_fks: Message |> order_by([m], m.id) |> select([m], {m.id, m.dm_conversation_id}) |> Repo.all(),
      cursor_fks: Cursor |> order_by([c], c.id) |> select([c], {c.id, c.dm_conversation_id}) |> Repo.all()
    }
  end

  setup do
    user = user_fixture()
    net = network_fixture()
    visitor = visitor_fixture(network_slug: net.slug)
    u = %{user_id: user.id}
    v = %{visitor_id: visitor.id}

    # Class A — tagged history. Inbound first, outbound later: the later raw
    # spelling is the one the conversation is minted with.
    alice_in = row(u, net, "me", "Alice", "Alice", :privmsg)
    alice_out = row(u, net, "alice", "ALICE", "me", :privmsg)
    # Class A with an open window spelled differently: the window wins.
    {:ok, _} = QueryWindows.open({:user, user.id}, net.id, "Bob", user.name)
    bob_in = row(u, net, "me", "BOB", "BOB", :privmsg)
    # Class B — legacy untagged DM rows: a service notice keyed on the
    # service, and a pre-CP14 inbound keyed on our own nick.
    nickserv = row(u, net, "NickServ", nil, "NickServ", :notice)
    legacy_self = row(u, net, "me", nil, "someone", :privmsg)
    # Class D — a conversation that exists only as an open window.
    {:ok, carol_window} = QueryWindows.open({:user, user.id}, net.id, "Carol", user.name)
    # The trap and the channels: never a conversation.
    server = row(u, net, "$server", nil, "irc.example.org", :notice)
    channel = row(u, net, "#grappa", nil, "alice", :privmsg)
    # The same peer, another subject.
    visitor_alice = row(v, net, "me", "alice", "alice", :privmsg)
    # A DM cursor whose key nothing else carries, plus a DM, a channel and a
    # `$server` cursor.
    seed_cursor(u, net, "dave", channel.id)
    seed_cursor(u, net, "alice", alice_out.id)
    seed_cursor(u, net, "#grappa", channel.id)
    seed_cursor(u, net, "$server", server.id)

    %{
      user: user,
      net: net,
      visitor: visitor,
      rows: %{
        alice_in: alice_in,
        alice_out: alice_out,
        bob_in: bob_in,
        nickserv: nickserv,
        legacy_self: legacy_self,
        server: server,
        channel: channel,
        visitor_alice: visitor_alice
      },
      carol_window: carol_window
    }
  end

  test "mints exactly the distinct DM keys of the four sources, per subject", ctx do
    run_migration!()

    assert :user_id |> by_key(ctx.user.id) |> Map.keys() |> Enum.sort() ==
             ["alice", "bob", "carol", "dave", "me", "nickserv"]

    assert :visitor_id |> by_key(ctx.visitor.id) |> Map.keys() == ["alice"]
    assert length(conversations()) == 7
  end

  test "every DM row points at its key's conversation, and nothing else points anywhere", ctx do
    run_migration!()

    assert DmConversationsHelpers.divergent_message_ids() == []

    mine = by_key(:user_id, ctx.user.id)
    assert fk_of(ctx.rows.alice_in) == mine["alice"].id
    assert fk_of(ctx.rows.alice_out) == mine["alice"].id
    assert fk_of(ctx.rows.bob_in) == mine["bob"].id
    assert fk_of(ctx.rows.nickserv) == mine["nickserv"].id
    # The declared deviation from the 2026-09-28 plan: the untagged own-nick
    # row is attached to the own-nick conversation, not left NULL.
    assert fk_of(ctx.rows.legacy_self) == mine["me"].id
    assert fk_of(ctx.rows.server) == nil
    assert fk_of(ctx.rows.channel) == nil
    assert fk_of(ctx.rows.visitor_alice) == by_key(:visitor_id, ctx.visitor.id)["alice"].id
  end

  test "open state mirrors query_windows; the window's spelling wins, else the latest", ctx do
    run_migration!()

    mine = by_key(:user_id, ctx.user.id)
    assert mine["carol"].opened_at == ctx.carol_window.opened_at
    assert %DateTime{} = mine["bob"].opened_at
    assert mine["bob"].peer_nick == "Bob"
    assert mine["alice"].opened_at == nil
    assert mine["alice"].peer_nick == "ALICE"
    assert mine["nickserv"].opened_at == nil
  end

  test "DM cursors point at their conversation; channel and $server cursors do not", ctx do
    run_migration!()

    mine = by_key(:user_id, ctx.user.id)
    assert cursor_fk(ctx.net, "dave") == mine["dave"].id
    assert cursor_fk(ctx.net, "alice") == mine["alice"].id
    assert cursor_fk(ctx.net, "#grappa") == nil
    assert cursor_fk(ctx.net, "$server") == nil
  end

  test "a re-run over a partially attached table converges to the same state", ctx do
    run_migration!()
    done = snapshot()

    # A crash after some batches: a prefix attached, the rest still NULL.
    Message
    |> where([m], m.id in ^[ctx.rows.alice_in.id, ctx.rows.nickserv.id])
    |> Repo.update_all(set: [dm_conversation_id: nil])

    Cursor
    |> where([c], c.channel == "dave")
    |> Repo.update_all(set: [dm_conversation_id: nil])

    rerun_up!()
    assert snapshot() == done

    rerun_up!()
    assert snapshot() == done
  end
end
