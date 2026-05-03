defmodule GrappaWeb.Plugs.AuthnTest do
  @moduledoc """
  Direct exercise of the `Authn` plug. We build conns with
  `Phoenix.ConnTest` and call `Authn.call/2` straight on them rather
  than going through the router — the router-level wiring is covered
  by 2c's controller tests.
  """
  use GrappaWeb.ConnCase, async: true

  import Ecto.Query
  import Grappa.AuthFixtures

  alias Grappa.{Accounts, Accounts.Session, Accounts.User, Repo}
  alias Grappa.Visitors.Visitor
  alias GrappaWeb.{FallbackController, Plugs.Authn}

  setup do
    # See `Grappa.Accounts.SessionsTest` for why we bypass create_user/1
    # here — Argon2 + sqlite single-writer = "Database busy" under load.
    {:ok, user} =
      Repo.insert(%User{
        name: "vjt-#{System.unique_integer([:positive])}",
        password_hash: "x"
      })

    {:ok, session} = Accounts.create_session({:user, user.id}, "127.0.0.1", "test-ua")
    %{user: user, session: session}
  end

  describe "valid Bearer token" do
    test "assigns :current_user_id + :current_session_id + :current_user and does NOT halt",
         %{conn: conn, user: user, session: session} do
      result =
        conn
        |> put_req_header("authorization", "Bearer #{session.id}")
        |> Authn.call(Authn.init([]))

      refute result.halted
      assert result.assigns.current_user_id == user.id
      assert result.assigns.current_session_id == session.id
      # S42: the plug also loads the User struct so downstream plugs +
      # controllers don't re-fetch. Pin the contract here so a future
      # "the controllers don't read this — drop the load" change fails
      # the plug's own test before it propagates.
      assert %User{id: user_id} = result.assigns.current_user
      assert user_id == user.id
    end
  end

  describe "missing / malformed Authorization header" do
    test "no header → 401 + halt", %{conn: conn} do
      result = Authn.call(conn, Authn.init([]))

      assert result.halted
      assert result.status == 401
      assert result.resp_body =~ "unauthorized"
    end

    test "non-Bearer scheme → 401 + halt", %{conn: conn} do
      result =
        conn
        |> put_req_header("authorization", "Basic deadbeef")
        |> Authn.call(Authn.init([]))

      assert result.halted
      assert result.status == 401
    end

    test "Bearer with empty token → 401 + halt", %{conn: conn} do
      result =
        conn
        |> put_req_header("authorization", "Bearer ")
        |> Authn.call(Authn.init([]))

      assert result.halted
      assert result.status == 401
    end
  end

  describe "Bearer with invalid / unknown / revoked / expired token" do
    test "non-UUID token → 401 + halt", %{conn: conn} do
      result =
        conn
        |> put_req_header("authorization", "Bearer not-a-uuid")
        |> Authn.call(Authn.init([]))

      assert result.halted
      assert result.status == 401
    end

    test "well-formed unknown UUID → 401 + halt", %{conn: conn} do
      result =
        conn
        |> put_req_header("authorization", "Bearer #{Ecto.UUID.generate()}")
        |> Authn.call(Authn.init([]))

      assert result.halted
      assert result.status == 401
    end

    test "revoked session token → 401 + halt", %{conn: conn, session: session} do
      :ok = Accounts.revoke_session(session.id)

      result =
        conn
        |> put_req_header("authorization", "Bearer #{session.id}")
        |> Authn.call(Authn.init([]))

      assert result.halted
      assert result.status == 401
    end

    test "expired session token → 401 + halt", %{conn: conn, session: session} do
      eight_days_ago = DateTime.add(DateTime.utc_now(), -8 * 24 * 3600, :second)

      query = from(s in Session, where: s.id == ^session.id)
      {1, _} = Repo.update_all(query, set: [last_seen_at: eight_days_ago])

      result =
        conn
        |> put_req_header("authorization", "Bearer #{session.id}")
        |> Authn.call(Authn.init([]))

      assert result.halted
      assert result.status == 401
    end
  end

  describe "visitor session branch" do
    setup %{conn: conn} do
      visitor = visitor_fixture(nick: "vjt", network_slug: "azzurra")
      {:ok, session} = Accounts.create_session({:visitor, visitor.id}, "1.2.3.4", "ua")

      {:ok, conn: conn, visitor: visitor, session: session}
    end

    test "valid visitor token assigns :current_visitor + :current_visitor_id, NOT current_user",
         %{conn: conn, visitor: visitor, session: session} do
      result =
        conn
        |> put_req_header("authorization", "Bearer #{session.id}")
        |> Authn.call(Authn.init([]))

      refute result.halted
      assert result.assigns.current_visitor_id == visitor.id
      assert %Visitor{id: vid} = result.assigns.current_visitor
      assert vid == visitor.id
      assert result.assigns.current_session_id == session.id
      refute Map.has_key?(result.assigns, :current_user)
      refute Map.has_key?(result.assigns, :current_user_id)
    end

    test "visitor authn bumps expires_at via Visitors.touch/1",
         %{conn: conn, session: session} do
      # visitor_fixture defaults to expires_at = now + 48h. Wind it back
      # so the cadence gate (1h) lets the bump through.
      older = DateTime.add(DateTime.utc_now(), 46, :hour)
      query = from(v in Visitor, where: v.id == ^session.visitor_id)
      {1, _} = Repo.update_all(query, set: [expires_at: older])

      conn
      |> put_req_header("authorization", "Bearer #{session.id}")
      |> Authn.call(Authn.init([]))

      bumped = Repo.get!(Visitor, session.visitor_id)
      assert DateTime.compare(bumped.expires_at, older) == :gt
    end

    # C1: visitor TTL expiry is a W11 purge boundary. The anon visitor
    # row + its session row MUST be cleaned synchronously on rejection
    # so a concurrent re-login by the same nick doesn't trip the
    # `(nick, network_slug)` uniqueness constraint against a tombstone
    # while waiting for the Reaper's 60s tick.
    test "expired ANON visitor → 401 + halt + visitor row purged + session revoked",
         %{conn: conn, session: session} do
      past = DateTime.add(DateTime.utc_now(), -1, :hour)
      query = from(v in Visitor, where: v.id == ^session.visitor_id)
      {1, _} = Repo.update_all(query, set: [expires_at: past])

      result =
        conn
        |> put_req_header("authorization", "Bearer #{session.id}")
        |> Authn.call(Authn.init([]))

      assert result.halted
      assert result.status == 401
      assert result.resp_body =~ "unauthorized"

      assert Repo.get(Visitor, session.visitor_id) == nil
      reloaded_session = Repo.get(Session, session.id)
      assert reloaded_session == nil or reloaded_session.revoked_at != nil
    end

    test "expired REGISTERED visitor → 401 + halt + visitor row STAYS + session revoked",
         %{conn: conn, session: session} do
      past = DateTime.add(DateTime.utc_now(), -1, :hour)
      query = from(v in Visitor, where: v.id == ^session.visitor_id)

      {1, _} =
        Repo.update_all(query,
          set: [expires_at: past, password_encrypted: "ns-pass"]
        )

      result =
        conn
        |> put_req_header("authorization", "Bearer #{session.id}")
        |> Authn.call(Authn.init([]))

      assert result.halted
      assert result.status == 401
      assert result.resp_body =~ "unauthorized"

      reloaded = Repo.get!(Visitor, session.visitor_id)
      assert reloaded.password_encrypted == "ns-pass"

      reloaded_session = Repo.get!(Session, session.id)
      assert reloaded_session.revoked_at != nil
    end
  end

  describe "401 response shape" do
    test "Content-Type is application/json and body is JSON {error: 'unauthorized'}",
         %{conn: conn} do
      result = Authn.call(conn, Authn.init([]))

      assert ["application/json" <> _] = get_resp_header(result, "content-type")
      assert result.resp_body == ~s({"error":"unauthorized"})
    end

    # M5: 401 body shape lives in ONE module — FallbackController. The
    # plug is upstream of every controller's `action_fallback` so it
    # needs its own 401 path, but the wire bytes must match the tag the
    # rest of the surface produces. If FallbackController's snake_case
    # convention shifts, this pin trips before clients diverge.
    #
    # Both branches receive the same raw conn — no `accepts/2`
    # preprocessing, no halted-state injection — so the assertion
    # exercises ONLY the body-byte equality and not any incidental
    # plug pipeline state.
    test "Authn 401 body matches FallbackController {:error, :unauthorized}",
         %{conn: conn} do
      authn_result = Authn.call(conn, Authn.init([]))
      fc_result = FallbackController.call(conn, {:error, :unauthorized})

      assert authn_result.status == fc_result.status
      assert authn_result.resp_body == fc_result.resp_body
    end
  end
end
