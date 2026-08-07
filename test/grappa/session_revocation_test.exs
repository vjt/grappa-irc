defmodule Grappa.SessionRevocationTest do
  @moduledoc """
  Door coverage for the `Grappa.Accounts.Revocations` announcement.

  The defect this pins is not "one call-site forgot to close the
  socket" — it is that closing the socket was a rule applied BY HAND at
  each door, and had drifted on 14 of them. So these tests are organised
  by door, not by function: every codepath that kills an
  `accounts_sessions` row must announce, whether it revokes the row, has
  it cascaded away, or reaps it on a timer.

  What is asserted is the announcement, not the socket teardown — that
  half is `GrappaWeb.SessionRevocationListenerTest`. Splitting them is
  the point of the indirection: the contexts owe an event, the web layer
  owes a disconnect.
  """
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.{Accounts, Visitors}
  alias Grappa.Accounts.{Revocations, Session}

  @idle_seconds 7 * 24 * 3600

  setup do
    :ok = Revocations.subscribe()
    :ok
  end

  describe "family A — the row is marked revoked_at" do
    test "revoke_session/1 names the user behind an opaque session id" do
      {user, session} = user_and_session()

      assert :ok = Accounts.revoke_session(session.id)

      assert_receive {:sessions_revoked, {:user, name}}
      assert name == user.name
    end

    test "revoke_session/1 names the visitor behind a visitor session" do
      visitor = visitor_fixture()
      session = visitor_session_fixture(visitor)

      assert :ok = Accounts.revoke_session(session.id)

      assert_receive {:sessions_revoked, {:visitor, id}}
      assert id == visitor.id
    end

    # Drives the `Plugs.Authn` stale-visitor doors (expired visitor /
    # orphaned session): both reach `revoke_session/1` with an id whose row
    # may be on its way out. A missing row has no subject to name, and
    # announcing an unresolved subject would close someone else's socket.
    test "revoke_session/1 announces nothing for an id with no row" do
      assert :ok = Accounts.revoke_session(Ecto.UUID.generate())

      refute_receive {:sessions_revoked, _}, 100
    end

    test "revoke_sessions_for_visitor/1 announces the visitor" do
      visitor = visitor_fixture()
      _ = visitor_session_fixture(visitor)

      assert :ok = Accounts.revoke_sessions_for_visitor(visitor.id)

      assert_receive {:sessions_revoked, {:visitor, id}}
      assert id == visitor.id
    end

    # Not gated on rows-affected: a subject whose only row was already
    # revoked — while its socket stayed up — must still be announced, or the
    # socket outlives every door that could have closed it.
    test "revoke_sessions_for_visitor/1 announces even when no row still matched" do
      visitor = visitor_fixture()

      assert :ok = Accounts.revoke_sessions_for_visitor(visitor.id)

      assert_receive {:sessions_revoked, {:visitor, id}}
      assert id == visitor.id
    end

    test "revoke_sessions_for_user/1 announces the user" do
      {user, _} = user_and_session()

      assert :ok = Accounts.revoke_sessions_for_user(user)

      assert_receive {:sessions_revoked, {:user, name}}
      assert name == user.name
    end

    test "revoke_other_sessions_for_user!/2 announces the whole subject, acting device included" do
      {user, keeper} = user_and_session()

      assert :ok = Accounts.revoke_other_sessions_for_user!(user, keeper.id)

      # The acting device's bearer survives — only its socket is torn down,
      # and it reconnects with the same token. This is the accepted blip of
      # per-subject granularity, asserted so a future per-session id-topic
      # has a test to change deliberately.
      assert {:ok, _} = Accounts.authenticate(keeper.id)
      assert_receive {:sessions_revoked, {:user, name}}
      assert name == user.name
    end

    # A6 / A7 — the two operator recovery doors. They revoke from INSIDE a
    # `Repo.BusyRetry.run(Repo.transaction(…))`, so this also pins that the
    # announcement survives the enclosing transaction.
    test "reset_totp/1 announces from inside its transaction" do
      {user, _} = user_and_session()

      assert {:ok, _} = Accounts.reset_totp(user.name)

      assert_receive {:sessions_revoked, {:user, name}}
      assert name == user.name
    end

    test "reset_passkeys/1 announces from inside its transaction" do
      {user, _} = user_and_session()

      assert {:ok, _} = Accounts.reset_passkeys(user.name)

      assert_receive {:sessions_revoked, {:user, name}}
      assert name == user.name
    end
  end

  describe "family B — the rows are cascaded or reaped away" do
    test "delete_user/1 announces the name the cascade is about to erase" do
      {user, _} = user_and_session()

      assert :ok = Accounts.delete_user(user)

      assert_receive {:sessions_revoked, {:user, name}}
      assert name == user.name
    end

    test "delete_expired_sessions/0 announces every owner it swept" do
      first = stale_session_owner()
      second = stale_session_owner()

      assert {:ok, 2} = Accounts.delete_expired_sessions()

      assert_receive {:sessions_revoked, {:user, one}}
      assert_receive {:sessions_revoked, {:user, two}}
      assert Enum.sort([one, two]) == Enum.sort([first.name, second.name])
    end

    test "delete_expired_sessions/0 announces nothing on an idle sweep" do
      assert {:ok, 0} = Accounts.delete_expired_sessions()

      refute_receive {:sessions_revoked, _}, 100
    end

    test "Visitors.delete/1 announces the visitor" do
      visitor = visitor_fixture()
      _ = visitor_session_fixture(visitor)

      assert :ok = Visitors.delete(visitor.id)

      assert_receive {:sessions_revoked, {:visitor, id}}
      assert id == visitor.id
    end

    test "purge_if_anon/1 announces the anon visitor it destroys" do
      visitor = visitor_fixture()
      _ = visitor_session_fixture(visitor)

      assert :ok = Visitors.purge_if_anon(visitor.id)

      assert_receive {:sessions_revoked, {:visitor, id}}
      assert id == visitor.id
    end

    # The reaper is the door that fires without an attacker: no request, no
    # operator, just a 60s timer deleting rows whose sockets stayed up. It
    # is covered without being touched, because it funnels through
    # `Visitors.delete/1`.
    test "the visitor reaper sweep announces each row it collects" do
      visitor = visitor_fixture()
      _ = visitor_session_fixture(visitor)
      expire(visitor)

      assert {:ok, 1} = Visitors.Reaper.sweep()

      assert_receive {:sessions_revoked, {:visitor, id}}
      assert id == visitor.id
    end
  end

  defp expire(visitor) do
    query = from(v in Visitors.Visitor, where: v.id == ^visitor.id)
    {1, _} = Repo.update_all(query, set: [expires_at: DateTime.add(DateTime.utc_now(), -1, :hour)])
    :ok
  end

  defp stale_session_owner do
    {user, session} = user_and_session()
    when_seen = DateTime.add(DateTime.utc_now(), -(@idle_seconds + 3600), :second)
    query = from(s in Session, where: s.id == ^session.id)
    {1, _} = Repo.update_all(query, set: [last_seen_at: when_seen])
    user
  end
end
