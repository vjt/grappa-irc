defmodule GrappaWeb.ShareTokenControllerTest do
  @moduledoc """
  `POST /me/share-token` and `POST /auth/share/consume`.

  Mint side (`/me/share-token`):
    * visitor subject → 200 + signed token + expires_at
    * user subject → 200 too (#1306 — the 403 this used to assert was
      the whole defect; a password subject shares to a second device
      with the same link)
    * incognito visitor subject → 403 forbidden (#363 — a non-portable
      ephemeral session must not be shareable to another device)
    * per-client token bearer → 403 client_token_scope (#1353 — the
      mint is credential management, so it takes a full session)
    * missing Bearer → 401 unauthorized

  Consume side (`/auth/share/consume`):
    * valid visitor token + visitor exists → 200 + bearer + visitor envelope
    * valid user token + user exists → 200 + bearer + user envelope
    * a `visitor-share-v1` token (untagged payload, old salt) → 401
    * unsigned/invalid token → 401 unauthorized
    * expired token (past TTL) → 410 gone
    * already-consumed token (second redemption) → 410 gone
    * subject row deleted between mint and consume → 404 not_found
    * missing token param → 400 bad_request

  Consume side, house failure window (#1387):
    * past the per-IP limit → 429, before the link is read
    * a spent / expired / orphaned link → never loads the window
    * the crossing → one `:login_throttled` naming this door

  Wire shape (mint):
    %{token: "<signed>", expires_at: "<ISO8601 UTC>"}

  Wire shape (consume success) — the `GrappaWeb.AuthJSON.login/1`
  envelope, per kind:
    %{token: "<bearer-uuid>", subject: %{kind: "visitor", id, registered}}
    %{token: "<bearer-uuid>", subject: %{kind: "user", id, name}}

  `async: true` — sandbox per test. Touches `Grappa.ShareTokens` but
  consume tests use distinct token strings so the suite-wide ETS table
  never collides.
  """
  use GrappaWeb.ConnCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.{Accounts, ShareTokens}
  alias Grappa.PubSub.Topic
  alias Grappa.RateLimit.FailureWindow
  alias Grappa.Repo.BusyRetry
  alias GrappaWeb.ShareToken

  # #982 — read from the production module rather than re-declared here.
  # Two doors mint this token now; a test carrying its own copy of the
  # salt would stay green through a drift that breaks both of them.
  @max_age_seconds ShareToken.max_age_seconds()
  @salt ShareToken.salt()

  # #1306 — the PRE-tag salt, frozen deliberately. This one IS a literal
  # copy, because it names a value production no longer holds: reading it
  # from `ShareToken.salt/0` would make the v1-refused test vacuous the
  # instant the salt regressed, which is the exact drift it exists to catch.
  @v1_salt "visitor-share-v1"

  describe "POST /me/share-token — mint" do
    test "visitor subject returns 200 + signed token + expires_at", %{conn: conn} do
      visitor = visitor_fixture()
      session = visitor_session_fixture(visitor)

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/me/share-token")

      body = json_response(conn, 200)
      assert is_binary(body["token"])
      assert body["token"] != ""

      # #1306 — the token verifies back to the TAGGED subject, not a bare
      # id: that tag is what tells the consume which table to read.
      assert {:ok, {:visitor, visitor_id}} = ShareToken.verify(body["token"])
      assert visitor_id == visitor.id

      # ISO8601 UTC string ~600s in the future (allow ±2s for clock skew
      # within the test).
      assert {:ok, expires_at, 0} = DateTime.from_iso8601(body["expires_at"])
      delta = DateTime.diff(expires_at, DateTime.utc_now())
      assert delta >= @max_age_seconds - 2
      assert delta <= @max_age_seconds + 2
    end

    test "user subject returns 200 + a token tagged :user (#1306)", %{conn: conn} do
      # This asserted 403 until #1306. The old rationale — "a user has a
      # password, they can just log in" — priced a password + TOTP entry
      # on a phone at zero.
      {user, session} = user_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/me/share-token")

      body = json_response(conn, 200)
      assert {:ok, {:user, user_id}} = ShareToken.verify(body["token"])
      assert user_id == user.id
    end

    test "an admin user is not excluded (#1306 ruling)", %{conn: conn} do
      # Explicitly ruled: an admin is just a user here. Pinned because
      # "surely not for admins" is the first instinct a later reader will
      # have, and a silent re-narrowing would be invisible otherwise.
      {admin, session} = user_and_session(is_admin: true)

      body =
        conn
        |> put_bearer(session.id)
        |> post("/me/share-token")
        |> json_response(200)

      assert {:ok, {:user, minted_for}} = ShareToken.verify(body["token"])
      assert minted_for == admin.id
    end

    test "the TTL is the same constant for a user as for a visitor" do
      # One constant for both kinds (#1306 ruling) — a user link is not
      # longer-lived just because the identity behind it is permanent.
      {_, user_session} = user_and_session()
      visitor_session = visitor_session_fixture(visitor_fixture())

      expiry = fn session ->
        body =
          Phoenix.ConnTest.build_conn()
          |> put_bearer(session.id)
          |> post("/me/share-token")
          |> json_response(200)

        {:ok, at, 0} = DateTime.from_iso8601(body["expires_at"])
        DateTime.diff(at, DateTime.utc_now())
      end

      assert_in_delta expiry.(user_session), expiry.(visitor_session), 2
    end

    test "incognito visitor subject returns 403 forbidden", %{conn: conn} do
      # #363 — an incognito session is deliberately non-portable; the mint
      # door is closed server-side, not just hidden in cic. #1306 removed
      # the user 403 and left this one VERBATIM: it is now the only
      # subject-shaped refusal on this door.
      visitor = visitor_fixture(incognito: true)
      session = visitor_session_fixture(visitor)

      conn =
        conn
        |> put_bearer(session.id)
        |> post("/me/share-token")

      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end

    test "missing Bearer returns 401 unauthorized", %{conn: conn} do
      conn = post(conn, "/me/share-token")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "only a full session mints a share link (#1353)", %{conn: conn} do
      # A share link hands the receiving device a session for the same
      # identity, so minting one is credential management: the door
      # belongs on the `:full_session` scope, alongside the token
      # surface it resembles. `GrappaWeb.RouterScopeTest` states the
      # same thing as a table-wide invariant; this arm pins the answer
      # at the door — the status AND the body — so a pipeline
      # reshuffle cannot quietly downgrade it to some other 4xx.
      {user, _} = user_and_session()
      {:ok, client_token} = Accounts.create_client_token(user, "headless", nil, nil, [])

      conn =
        conn
        |> put_bearer(client_token.id)
        |> post("/me/share-token")

      assert json_response(conn, 403) == %{"error" => "client_token_scope"}
    end
  end

  describe "POST /auth/share/consume — visitor token" do
    setup do
      # Each test gets its own visitor (ShareTokens ETS is suite-wide
      # but consume tests partition by the token string itself; distinct
      # signed payloads → distinct ETS keys).
      visitor = visitor_fixture()
      {:ok, {token, _}} = ShareToken.mint({:visitor, visitor.id}, :web)
      {:ok, visitor: visitor, token: token}
    end

    test "valid token + visitor exists returns 200 + bearer + subject envelope", %{
      conn: conn,
      visitor: visitor,
      token: token
    } do
      conn = post(conn, "/auth/share/consume", %{"token" => token})

      body = json_response(conn, 200)
      assert is_binary(body["token"])
      assert body["token"] != ""
      assert body["subject"]["kind"] == "visitor"
      assert body["subject"]["id"] == visitor.id
      # #211 phase 7 — the subject wire (visitor_to_credential_json) is
      # `{id, registered}`; nick DROPPED (visitors are multi-network, nick
      # lives per-network on GET /networks). `registered` is the derived
      # permanence flag (anon → false).
      assert body["subject"]["registered"] == false
      refute Map.has_key?(body["subject"], "nick")
      # #211 phase 6 — the singular subject `network_slug` is off the wire
      # (visitors are multi-network; per-network attachment on GET /networks).
      refute Map.has_key?(body["subject"], "network_slug")
    end

    test "consumed token authenticates as the SAME visitor (multi-device share)", %{
      conn: conn,
      visitor: visitor,
      token: token
    } do
      body = conn |> post("/auth/share/consume", %{"token" => token}) |> json_response(200)

      # Hit /me with the new bearer — confirms a real accounts_sessions
      # row was minted for the SAME visitor row.
      fresh_conn =
        Phoenix.ConnTest.build_conn()
        |> put_bearer(body["token"])
        |> get("/me")

      me = json_response(fresh_conn, 200)
      assert me["kind"] == "visitor"
      assert me["id"] == visitor.id
    end

    test "visitor deleted between mint and consume returns 404", %{
      conn: conn,
      visitor: visitor,
      token: token
    } do
      :ok = Grappa.Visitors.delete(visitor.id)

      conn = post(conn, "/auth/share/consume", %{"token" => token})
      assert json_response(conn, 404) == %{"error" => "not_found"}
    end
  end

  describe "POST /auth/share/consume — user token (#1306)" do
    setup do
      {user, _} = user_and_session()
      {:ok, {token, _}} = ShareToken.mint({:user, user.id}, :web)
      {:ok, user: user, token: token}
    end

    test "returns 200 + the user login envelope", %{conn: conn, user: user, token: token} do
      body = conn |> post("/auth/share/consume", %{"token" => token}) |> json_response(200)

      assert is_binary(body["token"])
      assert body["subject"]["kind"] == "user"
      assert body["subject"]["id"] == user.id
      assert body["subject"]["name"] == user.name
    end

    test "the minted bearer really authenticates as that user", %{
      conn: conn,
      user: user,
      token: token
    } do
      # The substantive outcome: not "a 200 came back" but "the second
      # device is logged in as the sharer". A branch that read the wrong
      # table would 404 here at the latest.
      body = conn |> post("/auth/share/consume", %{"token" => token}) |> json_response(200)

      me =
        Phoenix.ConnTest.build_conn()
        |> put_bearer(body["token"])
        |> get("/me")
        |> json_response(200)

      assert me["kind"] == "user"
      assert me["id"] == user.id
    end

    test "user deleted between mint and consume returns 404", %{conn: conn, token: token} do
      # Same 404 the visitor arm gives: a link outliving its identity is
      # one condition, not two.
      {other_user, _} = user_and_session()
      {:ok, {orphan_token, _}} = ShareToken.mint({:user, other_user.id}, :web)
      :ok = Grappa.Accounts.delete_user(other_user)

      orphan_conn = post(conn, "/auth/share/consume", %{"token" => orphan_token})
      assert json_response(orphan_conn, 404) == %{"error" => "not_found"}

      # Control: the live user's token in the same test still redeems, so
      # the 404 above is attributable to the deletion, not to the arm.
      assert Phoenix.ConnTest.build_conn()
             |> post("/auth/share/consume", %{"token" => token})
             |> json_response(200)
    end

    test "a user token is one-shot exactly like a visitor one", %{conn: conn, token: token} do
      assert conn |> post("/auth/share/consume", %{"token" => token}) |> json_response(200)

      assert Phoenix.ConnTest.build_conn()
             |> post("/auth/share/consume", %{"token" => token})
             |> json_response(410) == %{"error" => "share_token_consumed"}
    end
  end

  describe "POST /auth/share/consume — rejections" do
    test "a v1 token (untagged payload under the old salt) returns 401", %{conn: conn} do
      # #1306 — the salt bump is what makes the payload change safe. An
      # in-flight link from the untagged era cannot be re-read as EITHER
      # kind; it is simply not ours any more.
      visitor = visitor_fixture()
      v1_token = Phoenix.Token.sign(GrappaWeb.Endpoint, @v1_salt, visitor.id)

      conn = post(conn, "/auth/share/consume", %{"token" => v1_token})
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "a correctly-salted token with an untagged payload returns 401", %{conn: conn} do
      # Reaching the v2 namespace is necessary but not sufficient: the
      # payload still has to present a kind the branch understands.
      visitor = visitor_fixture()
      untagged = Phoenix.Token.sign(GrappaWeb.Endpoint, @salt, visitor.id)

      conn = post(conn, "/auth/share/consume", %{"token" => untagged})
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "unsigned / invalid token returns 401 unauthorized", %{conn: conn} do
      conn = post(conn, "/auth/share/consume", %{"token" => "not-a-signed-token"})
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "expired token (TTL elapsed) returns 410 gone", %{conn: conn} do
      # Sign with a baseline now, then verify with max_age that already
      # elapsed by passing a `signed_at` parameter that's older than TTL.
      visitor = visitor_fixture()
      old_signed_at = System.system_time(:second) - @max_age_seconds - 60

      token =
        Phoenix.Token.sign(GrappaWeb.Endpoint, @salt, {:visitor, visitor.id}, signed_at: old_signed_at)

      conn = post(conn, "/auth/share/consume", %{"token" => token})
      assert json_response(conn, 410) == %{"error" => "share_token_expired"}
    end

    test "missing token param returns 400 bad_request", %{conn: conn} do
      conn = post(conn, "/auth/share/consume", %{})
      assert json_response(conn, 400) == %{"error" => "bad_request"}
    end
  end

  describe "POST /auth/share/consume — one-shot claim (#593)" do
    setup do
      visitor = visitor_fixture()
      {:ok, {token, _}} = ShareToken.mint({:visitor, visitor.id}, :web)
      {:ok, visitor: visitor, token: token}
    end

    test "already-consumed token returns 410 gone on second call", %{conn: conn, token: token} do
      conn1 = post(conn, "/auth/share/consume", %{"token" => token})
      assert json_response(conn1, 200)

      fresh_conn = post(Phoenix.ConnTest.build_conn(), "/auth/share/consume", %{"token" => token})
      assert json_response(fresh_conn, 410) == %{"error" => "share_token_consumed"}
    end

    test "transient DB saturation on the mint leaves the token usable for a retry", %{
      conn: conn,
      visitor: visitor,
      token: token
    } do
      # #593 — the hard half of the contract. The one-shot claim is taken
      # (mark_consumed) BEFORE the session mint. Force the mint (a
      # BusyRetry-wrapped INSERT) to exhaust its budget → {:error,
      # :db_unavailable} → a retryable 503. The claim MUST roll back, else
      # the retry the 503 invites can never succeed — a dead link.
      BusyRetry.inject_transient_faults(10_000)
      conn1 = post(conn, "/auth/share/consume", %{"token" => token})
      assert json_response(conn1, 503)["error"] == "db_unavailable"

      # White-box confirmation the compensating release fired: the token is
      # absent from the consumed ledger.
      refute token in ShareTokens.all_keys()

      # Black-box proof: with the transient faults cleared, the SAME link
      # mints for real. A dead link would 410 here.
      BusyRetry.inject_transient_faults(0)

      body =
        Phoenix.ConnTest.build_conn()
        |> post("/auth/share/consume", %{"token" => token})
        |> json_response(200)

      assert body["subject"]["id"] == visitor.id
    end

    test "a losing concurrent redemption's 410 does NOT release the winner's claim", %{
      conn: conn,
      token: token
    } do
      # #593 — the release must be scoped to THIS request's own post-consume
      # failure. A flat `else` would fire release on the LOSER's
      # `:share_token_consumed` too, deleting the WINNER's claim and
      # resurrecting a token that already minted a session (a worse bug:
      # dead-link → double-redemption). Winner mints, claim retained:
      assert conn |> post("/auth/share/consume", %{"token" => token}) |> json_response(200)

      # Loser hits the same token → 410. This 410 must leave the claim intact.
      assert Phoenix.ConnTest.build_conn()
             |> post("/auth/share/consume", %{"token" => token})
             |> json_response(410) == %{"error" => "share_token_consumed"}

      # Proof the winner's claim survived the loser's 410: still 410, never 200.
      assert Phoenix.ConnTest.build_conn()
             |> post("/auth/share/consume", %{"token" => token})
             |> json_response(410) == %{"error" => "share_token_consumed"}
    end
  end

  # ----- consume-throttle helpers (#1387) — module level; ExUnit forbids
  # defp inside describe. Each test below gets its OWN source address:
  # the window is per-IP, so a distinct address isolates one test's
  # counter from the sibling describes (all on 127.0.0.1) and from any
  # file sharing the process-wide ETS table.
  defp with_ip(conn, d), do: %{conn | remote_ip: {10, 67, 0, d}}

  defp consume_invalid(conn, d) do
    conn |> with_ip(d) |> post("/auth/share/consume", %{"token" => "not-a-signed-token"})
  end

  defp consume(conn, d, token) do
    conn |> with_ip(d) |> post("/auth/share/consume", %{"token" => token})
  end

  defp minted_for_new_visitor do
    visitor = visitor_fixture()
    {:ok, {token, _}} = ShareToken.mint({:visitor, visitor.id}, :web)
    {visitor, token}
  end

  describe "POST /auth/share/consume — house failure window (#1387)" do
    # Clear only THIS door's rows for the addresses used below. Wiping
    # the whole table (the sibling files' idiom) would reach into a
    # concurrently running file's window, and this file is `async: true`.
    setup do
      for d <- 1..6, do: :ok = FailureWindow.clear(:share_token_consume, "10.67.0.#{d}")
      :ok
    end

    test "past the limit the address is refused before the link is even read", %{conn: conn} do
      {_, token} = minted_for_new_visitor()

      for _ <- 1..10 do
        assert json_response(consume_invalid(conn, 1), 401) == %{"error" => "unauthorized"}
      end

      # The check precedes verification: a GENUINE link presented from the
      # same address is refused without being read.
      assert json_response(consume(conn, 1, token), 429) == %{"error" => "too_many_attempts"}

      # And the refusal did not spend it — the window is a property of the
      # address, never of the link, so another address still redeems.
      assert Phoenix.ConnTest.build_conn()
             |> consume(2, token)
             |> json_response(200)
    end

    test "a spent link retried from the same address never loads the window", %{conn: conn} do
      # The honest double click, and the PWA that retries its own request.
      # Charging that shape locks out precisely the legitimate holder.
      {_, token} = minted_for_new_visitor()
      assert json_response(consume(conn, 3, token), 200)

      for _ <- 1..12 do
        assert json_response(consume(conn, 3, token), 410) == %{"error" => "share_token_consumed"}
      end

      # Nothing was charged: the address still has its whole window, so an
      # unreadable token gets a first-failure answer rather than a refusal.
      assert json_response(consume_invalid(conn, 3), 401) == %{"error" => "unauthorized"}
    end

    test "a link that has run out never loads the window", %{conn: conn} do
      visitor = visitor_fixture()

      token =
        Phoenix.Token.sign(GrappaWeb.Endpoint, @salt, {:visitor, visitor.id},
          signed_at: System.system_time(:second) - @max_age_seconds - 60
        )

      for _ <- 1..12 do
        assert json_response(consume(conn, 4, token), 410) == %{"error" => "share_token_expired"}
      end

      assert json_response(consume_invalid(conn, 4), 401) == %{"error" => "unauthorized"}
    end

    test "a link whose subject is gone never loads the window", %{conn: conn} do
      # The signature held, so the holder is not guessing at anything: the
      # row went away underneath a real link. That is the reaper's timing,
      # not the caller's conduct.
      {visitor, token} = minted_for_new_visitor()
      :ok = Grappa.Visitors.delete(visitor.id)

      for _ <- 1..12 do
        assert json_response(consume(conn, 5, token), 404) == %{"error" => "not_found"}
      end

      assert json_response(consume_invalid(conn, 5), 401) == %{"error" => "unauthorized"}
    end

    test "crossing the limit names this door to the operator, exactly once", %{conn: conn} do
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, Topic.admin_events())

      for _ <- 1..10, do: consume_invalid(conn, 6)

      assert_receive %Phoenix.Socket.Broadcast{
                       topic: "grappa:admin:events",
                       payload: %{
                         kind: :login_throttled,
                         door: :share_token_consume,
                         scope: :ip,
                         source_ip: "10.67.0.6",
                         failures: 10
                       }
                     },
                     500

      # The rejections that follow must not re-emit, or a spray floods the
      # admin stream with its own refusals. Matched on THIS door AND this
      # test's address. With the door alone, seed 789007 failed this test on
      # main as well: a crossing from 10.67.0.1, the address the sibling test
      # above throttles, arrived inside the refute window. AdminEvents.record/1
      # is a cast, so a broadcast can land after the test that caused it — the
      # mechanism is inferred, the failure measured.
      _ = consume_invalid(conn, 6)

      refute_receive %Phoenix.Socket.Broadcast{
                       payload: %{kind: :login_throttled, door: :share_token_consume, source_ip: "10.67.0.6"}
                     },
                     200
    end
  end

  describe "telemetry" do
    setup do
      handler = "share-token-telemetry-#{System.unique_integer([:positive])}"
      parent = self()

      :ok =
        :telemetry.attach_many(
          handler,
          [
            [:grappa, :share_token, :minted],
            [:grappa, :share_token, :consumed],
            [:grappa, :share_token, :rejected]
          ],
          fn event, measurements, metadata, _ ->
            send(parent, {:telemetry, event, measurements, metadata})
          end,
          nil
        )

      on_exit(fn -> :telemetry.detach(handler) end)
      :ok
    end

    test "mint emits :minted tagged with the subject kind", %{conn: conn} do
      # #1306 — the metadata carries `subject_kind` + `subject_id`, not a
      # `visitor_id` that would be a lie for half its emitters.
      visitor = visitor_fixture()
      session = visitor_session_fixture(visitor)

      conn |> put_bearer(session.id) |> post("/me/share-token") |> json_response(200)

      assert_receive {:telemetry, [:grappa, :share_token, :minted], %{count: 1},
                      %{subject_kind: :visitor, subject_id: sid}}

      assert sid == visitor.id
    end

    test "a user mint emits :minted with subject_kind :user", %{conn: conn} do
      {user, session} = user_and_session()

      conn |> put_bearer(session.id) |> post("/me/share-token") |> json_response(200)

      assert_receive {:telemetry, [:grappa, :share_token, :minted], %{count: 1},
                      %{subject_kind: :user, subject_id: sid}}

      assert sid == user.id
    end

    test "consume happy path emits :consumed with the subject metadata", %{conn: conn} do
      visitor = visitor_fixture()
      {:ok, {token, _}} = ShareToken.mint({:visitor, visitor.id}, :web)

      conn |> post("/auth/share/consume", %{"token" => token}) |> json_response(200)

      assert_receive {:telemetry, [:grappa, :share_token, :consumed], %{count: 1},
                      %{subject_kind: :visitor, subject_id: sid}}

      assert sid == visitor.id
    end

    test "consume rejects emit :rejected with :reason metadata", %{conn: conn} do
      # invalid signature → :unauthorized
      conn |> post("/auth/share/consume", %{"token" => "bogus"}) |> json_response(401)

      assert_receive {:telemetry, [:grappa, :share_token, :rejected], %{count: 1}, %{reason: :unauthorized}}

      # expired
      visitor = visitor_fixture()

      expired_token =
        Phoenix.Token.sign(GrappaWeb.Endpoint, @salt, {:visitor, visitor.id},
          signed_at: System.system_time(:second) - @max_age_seconds - 60
        )

      conn |> post("/auth/share/consume", %{"token" => expired_token}) |> json_response(410)

      assert_receive {:telemetry, [:grappa, :share_token, :rejected], %{count: 1}, %{reason: :share_token_expired}}
    end

    test "a saturated mint (503) emits exactly one :rejected{db_unavailable}, no :consumed", %{
      conn: conn
    } do
      # #593 — the post-claim failure path is DRY'd through `reject/1`; assert
      # it fires the reject telemetry once (not zero, not doubled) and never
      # the :consumed event when the mint rolls its claim back.
      visitor = visitor_fixture()
      {:ok, {token, _}} = ShareToken.mint({:visitor, visitor.id}, :web)

      BusyRetry.inject_transient_faults(10_000)
      conn |> post("/auth/share/consume", %{"token" => token}) |> json_response(503)
      BusyRetry.inject_transient_faults(0)

      assert_receive {:telemetry, [:grappa, :share_token, :rejected], %{count: 1}, %{reason: :db_unavailable}}

      refute_received {:telemetry, [:grappa, :share_token, :rejected], _, _}
      refute_received {:telemetry, [:grappa, :share_token, :consumed], _, _}
    end
  end
end
