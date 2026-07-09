defmodule GrappaWeb.MeControllerTest do
  @moduledoc """
  `GET /me` returns the authenticated subject's public profile as a
  discriminated union — `{kind: "user", id, name, inserted_at}` for
  user sessions, `{kind: "visitor", id, nick, network_slug, expires_at}`
  for visitor sessions (Task 30 — mirrors `AuthJSON.subject_wire` +
  per-kind timestamp). The route lives behind the `:authn` pipeline so
  the authentication failure modes (no Bearer, revoked, expired) all
  collapse to a uniform 401 here.

  `async: true` — sandbox per test, no shared state.
  """
  use GrappaWeb.ConnCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.{Accounts, Repo, Visitors}
  alias Grappa.Accounts.User
  alias Grappa.Visitors.Visitor
  alias GrappaWeb.MeController

  describe "GET /me — user subject" do
    test "with valid Bearer returns 200 + discriminated user profile", %{conn: conn} do
      {user, session} = user_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/me")

      body = json_response(conn, 200)
      assert body["kind"] == "user"
      assert body["id"] == user.id
      assert body["name"] == user.name
      assert is_binary(body["inserted_at"])
      # M-cluster M-2: SSoT addition to user wire — admin gating reads
      # off the /me envelope. Default user is non-admin.
      assert body["is_admin"] == false
      # CP29 R-3: read_cursors envelope. Empty for a fresh subject.
      assert body["read_cursors"] == %{}
      # Bucket C (2026-06-01): unread_counts envelope. Empty for a
      # fresh subject (no cursors → no entries).
      assert body["unread_counts"] == %{}
      # PWA badge door #2 (2026-06-21): 0 for a fresh subject.
      assert body["badge_count"] == 0
      # UX-4 bucket B: home_data envelope. Fresh user with zero
      # credentials → empty networks list (NOT nil — nil is the
      # visitor signal).
      assert body["home_data"] == %{"networks" => []}
      refute Map.has_key?(body, "password_hash")
      refute Map.has_key?(body, "password")
      refute Map.has_key?(body, "nick")
      refute Map.has_key?(body, "network_slug")
      refute Map.has_key?(body, "expires_at")
    end

    test "without Bearer returns 401", %{conn: conn} do
      conn = get(conn, "/me")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "with revoked Bearer returns 401", %{conn: conn} do
      {_, session} = user_and_session()
      :ok = Accounts.revoke_session(session.id)

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/me")

      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "with malformed Bearer returns 401", %{conn: conn} do
      conn =
        conn
        |> put_bearer("not-a-uuid")
        |> get("/me")

      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "with unknown UUID Bearer returns 401", %{conn: conn} do
      conn =
        conn
        |> put_bearer(Ecto.UUID.generate())
        |> get("/me")

      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end
  end

  describe "GET /me — visitor subject" do
    test "with valid visitor Bearer returns 200 + discriminated visitor profile",
         %{conn: conn} do
      {visitor, session} = visitor_and_session(nick: "vjt", network_slug: "azzurra")

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/me")

      body = json_response(conn, 200)
      assert body["kind"] == "visitor"
      assert body["id"] == visitor.id
      assert body["nick"] == "vjt"
      assert body["network_slug"] == "azzurra"
      assert is_binary(body["expires_at"])
      # CP29 R-3: read_cursors envelope present for visitors too.
      assert body["read_cursors"] == %{}
      # Bucket C (2026-06-01): unread_counts envelope present for
      # visitors too. Empty for a fresh visitor (no cursors).
      assert body["unread_counts"] == %{}
      # PWA badge door #2 (2026-06-21): 0 for a fresh visitor.
      assert body["badge_count"] == 0
      # UX-4 bucket B: visitors get `home_data: nil` — visitor home is
      # cic-only help text (no server roundtrip). The discriminator
      # nil vs %{networks: [...]} is how cic dispatches
      # HomePaneVisitor vs HomePaneRegistered.
      assert body["home_data"] == nil
      # #126: visitor /me carries the whereis-derived `connected` flag
      # (drives the SettingsDrawer disconnect ⇄ reconnect toggle) + the
      # `registered` flag (= password_encrypted present; the cic
      # detach/disconnect gate). A fresh anon visitor has neither a live
      # session nor a NickServ identity.
      assert body["connected"] == false
      assert body["registered"] == false
      refute Map.has_key?(body, "name")
      refute Map.has_key?(body, "inserted_at")
      refute Map.has_key?(body, "password_encrypted")
      # M-cluster M-2: visitors NEVER carry is_admin (the bit lives on
      # User schema only). The discriminated-union shape pins the
      # absence so a future wire drift surfaces here.
      refute Map.has_key?(body, "is_admin")
    end

    test "with revoked visitor Bearer returns 401", %{conn: conn} do
      {_, session} = visitor_and_session()
      :ok = Accounts.revoke_session(session.id)

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/me")

      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end
  end

  # CP29 R-3 — read_cursors envelope from /me reflects what
  # `Grappa.ReadCursor.bulk_for_subject/1` returns. End-to-end check
  # that the controller wires the bulk fetch + the renderer keeps the
  # nested {slug => {channel => id}} shape.
  describe "GET /me — read_cursors envelope" do
    test "returns nested shape grouped by network slug then channel", %{conn: conn} do
      {user, session} = user_and_session()
      {network, _} = network_with_server(port: 7401, slug: "envelope-#{System.unique_integer([:positive])}")
      _ = credential_fixture(user, network)

      {:ok, m1} =
        Grappa.ScrollbackHelpers.insert(%{
          user_id: user.id,
          network_id: network.id,
          channel: "#a",
          server_time: 1,
          kind: :privmsg,
          sender: "vjt",
          body: "hi"
        })

      {:ok, _} = Grappa.ReadCursor.set({:user, user.id}, network.id, "#a", m1.id)

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/me")

      body = json_response(conn, 200)
      assert body["read_cursors"][network.slug] == %{"#a" => m1.id}
    end
  end

  # Bucket C (2026-06-01) — unread_counts envelope mirrors the
  # cursor envelope shape; cic's `applySeedEnvelope` consumes the
  # {messages, events} pair byte-for-byte. End-to-end check that the
  # controller threads cursors → `bulk_unread_split_for_subject/2`
  # and the renderer preserves the nested shape.
  describe "GET /me — unread_counts envelope" do
    test "returns nested {slug => chan => {messages, events}} for cursored channels",
         %{conn: conn} do
      {user, session} = user_and_session()

      {network, _} =
        network_with_server(port: 7405, slug: "unread-#{System.unique_integer([:positive])}")

      _ = credential_fixture(user, network)

      # Anchor cursor at row 0 so every following row is unread.
      {:ok, anchor} =
        Grappa.ScrollbackHelpers.insert(%{
          user_id: user.id,
          network_id: network.id,
          channel: "#a",
          server_time: 1,
          kind: :privmsg,
          sender: "vjt",
          body: "anchor"
        })

      {:ok, _} = Grappa.ReadCursor.set({:user, user.id}, network.id, "#a", anchor.id)

      # Two content + one presence row after the cursor.
      for {i, kind, body} <- [{2, :privmsg, "m1"}, {3, :notice, "m2"}] do
        {:ok, _} =
          Grappa.ScrollbackHelpers.insert(%{
            user_id: user.id,
            network_id: network.id,
            channel: "#a",
            server_time: i,
            kind: kind,
            sender: "vjt",
            body: body
          })
      end

      {:ok, _} =
        Grappa.ScrollbackHelpers.insert(%{
          user_id: user.id,
          network_id: network.id,
          channel: "#a",
          server_time: 4,
          kind: :join,
          sender: "vjt",
          body: nil
        })

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/me")

      body = json_response(conn, 200)

      assert body["unread_counts"][network.slug] == %{
               "#a" => %{"messages" => 2, "events" => 1}
             }
    end

    test "channels without a cursor are absent from unread_counts", %{conn: conn} do
      {user, session} = user_and_session()

      {network, _} =
        network_with_server(port: 7406, slug: "noseed-#{System.unique_integer([:positive])}")

      _ = credential_fixture(user, network)

      {:ok, _} =
        Grappa.ScrollbackHelpers.insert(%{
          user_id: user.id,
          network_id: network.id,
          channel: "#cursorless",
          server_time: 1,
          kind: :privmsg,
          sender: "vjt",
          body: "no-cursor"
        })

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/me")

      body = json_response(conn, 200)
      # No cursor was set → no entry in unread_counts (cic falls back
      # to the per-channel join reply seed from bucket B1).
      refute Map.has_key?(body["unread_counts"], network.slug)
    end

    # S2 review-fix regression guard — inclusion is keyed on the GLOBAL
    # network index, NOT the credential-scoped own-nick window map. A
    # user can unbind a network yet retain its scrollback + read cursors
    # (GH #105 — unbind deletes only the credential row), and those
    # cursors MUST still seed unread_counts (matching the WS join_reply
    # door). Here the network has NO credential for the user: own_nick
    # resolves to nil (channel-shape narrowing), but the #channel count
    # is still seeded. A credential-scoped inclusion would drop it.
    test "cursored network with no credential still seeds unread_counts",
         %{conn: conn} do
      {user, session} = user_and_session()

      {network, _} =
        network_with_server(port: 7410, slug: "nocred-#{System.unique_integer([:positive])}")

      # Deliberately NO credential_fixture/2 — mirror the unbind-but-
      # retain-scrollback state (network row exists, no credential row).
      {:ok, anchor} =
        Grappa.ScrollbackHelpers.insert(%{
          user_id: user.id,
          network_id: network.id,
          channel: "#retained",
          server_time: 1,
          kind: :privmsg,
          sender: "peer",
          body: "anchor"
        })

      {:ok, _} = Grappa.ReadCursor.set({:user, user.id}, network.id, "#retained", anchor.id)

      {:ok, _} =
        Grappa.ScrollbackHelpers.insert(%{
          user_id: user.id,
          network_id: network.id,
          channel: "#retained",
          server_time: 2,
          kind: :privmsg,
          sender: "peer",
          body: "after-cursor"
        })

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/me")

      body = json_response(conn, 200)

      assert body["unread_counts"][network.slug]["#retained"] ==
               %{"messages" => 1, "events" => 0}
    end

    # PROD HOTFIX 2026-06-01 — `ReadCursor.bulk_for_subject/1` returns
    # `c.last_read_message_id` as-is; the column is nullable so a row
    # with explicit-no-cursor or legacy-null state surfaces as a nil
    # in the envelope. Pre-fix `build_unread_counts/2` passed the nil
    # straight to `Scrollback.count_after_split/5` whose head guard is
    # `is_integer(after_id)` → FunctionClauseError → 500 on the whole
    # /me response → cic's `user()` signal stays unresolved → Shell
    # renders the cold "select a channel below" placeholder with no
    # admin console. vjt hit this on prod with a nil cursor on #bofh.
    test "channels with a nil cursor in the envelope are dropped (no 500)",
         %{conn: conn} do
      {user, session} = user_and_session()

      {network, _} =
        network_with_server(port: 7407, slug: "nilcur-#{System.unique_integer([:positive])}")

      _ = credential_fixture(user, network)

      # Insert a cursor row with `last_read_message_id: nil` directly via
      # `Repo.insert!` — the public `ReadCursor.set/4` API only accepts
      # integer ids, so we go around it to reproduce the legacy/explicit
      # nil-id state that DOES exist in vjt's prod DB.
      Grappa.Repo.insert!(%Grappa.ReadCursor.Cursor{
        user_id: user.id,
        visitor_id: nil,
        network_id: network.id,
        channel: "#nilcursor",
        last_read_message_id: nil
      })

      # Persist some rows so a buggy build_unread_counts would
      # actually try to count them.
      for {i, kind} <- [{1, :privmsg}, {2, :notice}] do
        {:ok, _} =
          Grappa.ScrollbackHelpers.insert(%{
            user_id: user.id,
            network_id: network.id,
            channel: "#nilcursor",
            server_time: i,
            kind: kind,
            sender: "vjt",
            body: "row-#{i}"
          })
      end

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/me")

      # Pre-fix: this assertion never ran — the controller 500'd.
      # Post-fix: nil-cursor entry is filtered out, network slug
      # absent from unread_counts (cic falls back to join_reply seed).
      body = json_response(conn, 200)
      assert is_map(body["unread_counts"])
      refute Map.has_key?(body["unread_counts"], network.slug)
    end

    # S2 (2026-07-08 codebase review) — the own-nick query window
    # (`channel == own_nick`) must narrow to self-msgs only. The two
    # doors that seed the same badge — the per-channel WS `join_reply`
    # and this `/me` cold-load — MUST agree. Pre-fix `build_unread_counts/2`
    # passed no `own_nick`, so `channel_or_dm_where/3` fell through to
    # the peer-DM OR-shape and counted EVERY inbound DM ever received
    # (all stored at `channel = own_nick`), over-counting the own-nick
    # window vs the WS door (which threads `own_nick`). own_nick resolves
    # off-Session from the configured credential nick (same stance as
    # `Push.BadgeCount`), so the fix needs no live session.
    test "own-nick window excludes inbound DMs — /me matches the WS join_reply count",
         %{conn: conn} do
      {user, session} = user_and_session()

      {network, _} =
        network_with_server(port: 7409, slug: "ownnick-#{System.unique_integer([:positive])}")

      # credential_fixture defaults nick "grappa-test" → the own-nick
      # query window is keyed on channel "grappa-test".
      _ = credential_fixture(user, network)
      own_nick = "grappa-test"

      # Cursor on the own-nick window at row 0 so both rows are unread.
      {:ok, anchor} =
        Grappa.ScrollbackHelpers.insert(%{
          user_id: user.id,
          network_id: network.id,
          channel: own_nick,
          server_time: 1,
          kind: :privmsg,
          sender: "peer",
          body: "anchor"
        })

      {:ok, _} = Grappa.ReadCursor.set({:user, user.id}, network.id, own_nick, anchor.id)

      # Inbound DM from a peer — stored at `channel = own_nick, dm_with =
      # peer`. This must NOT inflate the own-nick window count.
      {:ok, _} =
        Grappa.Scrollback.persist_event(%{
          user_id: user.id,
          network_id: network.id,
          channel: own_nick,
          server_time: 2,
          kind: :privmsg,
          sender: "peer",
          body: "inbound-dm",
          meta: %{},
          dm_with: "peer"
        })

      # A genuine self-msg (`/msg <ownnick>`) — stored at `channel =
      # dm_with = own_nick`. This IS a member of the own-nick window.
      {:ok, _} =
        Grappa.Scrollback.persist_event(%{
          user_id: user.id,
          network_id: network.id,
          channel: own_nick,
          server_time: 3,
          kind: :privmsg,
          sender: own_nick,
          body: "note-to-self",
          meta: %{},
          dm_with: own_nick
        })

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/me")

      body = json_response(conn, 200)

      # Only the self-msg counts — the inbound DM is narrowed out.
      assert body["unread_counts"][network.slug][own_nick] ==
               %{"messages" => 1, "events" => 0}

      # Door parity: the /me total equals what the WS `join_reply` seeds
      # via the SAME predicate `Scrollback.count_after/5`, with own_nick
      # resolved to the configured nick.
      ws_count =
        Grappa.Scrollback.count_after({:user, user.id}, network.id, own_nick, anchor.id, own_nick)

      %{"messages" => m, "events" => e} = body["unread_counts"][network.slug][own_nick]
      assert m + e == ws_count
    end
  end

  # PWA icon badge door #2 (2026-06-21) — top-level `badge_count` from
  # `Grappa.Push.BadgeCount.count/1`: notify-worthy unread total (same
  # predicate as Web Push), capped at 99. End-to-end check that the
  # controller threads the count and the renderer surfaces the scalar.
  describe "GET /me — badge_count envelope" do
    test "counts notify-worthy unread; excludes :notice + presence events",
         %{conn: conn} do
      {user, session} = user_and_session()

      {network, _} =
        network_with_server(port: 7408, slug: "badge-#{System.unique_integer([:positive])}")

      # credential_fixture defaults nick "grappa-test" — own_nick resolves
      # off-Session via the configured credential nick.
      _ = credential_fixture(user, network)

      # channel-all prefs so every CONTENT row would count — proving the
      # :notice + :join exclusions come from the predicate / kind filter,
      # not from prefs.
      {:ok, _} =
        Grappa.UserSettings.put_notification_prefs(
          {:user, user.id},
          Map.merge(Grappa.UserSettings.default_notification_prefs(), %{channel_messages_all: true})
        )

      {:ok, anchor} =
        Grappa.ScrollbackHelpers.insert(%{
          user_id: user.id,
          network_id: network.id,
          channel: "#a",
          server_time: 1,
          kind: :privmsg,
          sender: "alice",
          body: "anchor"
        })

      {:ok, _} = Grappa.ReadCursor.set({:user, user.id}, network.id, "#a", anchor.id)

      # After the cursor: 2 privmsgs (count), 1 notice (kind-gated out by
      # should_notify?), 1 join (dropped at the content-kind SQL filter).
      for {i, kind, body} <- [
            {2, :privmsg, "m1"},
            {3, :privmsg, "m2"},
            {4, :notice, "services blurb"},
            {5, :join, nil}
          ] do
        {:ok, _} =
          Grappa.ScrollbackHelpers.insert(%{
            user_id: user.id,
            network_id: network.id,
            channel: "#a",
            server_time: i,
            kind: kind,
            sender: "bob",
            body: body
          })
      end

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/me")

      body = json_response(conn, 200)
      assert body["badge_count"] == 2
    end
  end

  describe "GET /me — defensive fall-through" do
    test "missing :current_subject returns {:error, :unauthorized} (W8)", %{conn: conn} do
      # W8: simulate a regressed pipeline by invoking the action with no
      # :current_subject in assigns. Pre-W8 this raised KeyError → 500.
      # Post-W8 the fall-through clause returns the action_fallback shape
      # {:error, :unauthorized} which FallbackController maps to a uniform
      # 401 wire body (verified end-to-end by the no-Bearer test above).
      assert MeController.show(conn, %{}) == {:error, :unauthorized}
    end
  end

  # UX-4 bucket B (2026-05-18); REV-J M15 (2026-05-22) — home_data
  # envelope for users with bound credentials. Pins both the projection
  # shape AND the parity contract: the row shape in
  # `home_data.networks[*]` must be structurally identical to the
  # `:network` field of the `connection_state_changed` typed event
  # (REV-J M15 folded the prior `home_network_state_changed` arm into
  # that payload), so a future field add can't drift the two consumers.
  describe "GET /me — home_data envelope" do
    test "user with bound credentials gets one home_data row per credential",
         %{conn: conn} do
      {user, session} = user_and_session()
      slug1 = "home-#{System.unique_integer([:positive])}"
      slug2 = "home-#{System.unique_integer([:positive])}"
      {net1, _} = network_with_server(port: 7402, slug: slug1)
      {net2, _} = network_with_server(port: 7403, slug: slug2)
      _ = credential_fixture(user, net1)
      _ = credential_fixture(user, net2)

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/me")

      body = json_response(conn, 200)

      assert %{"networks" => rows} = body["home_data"]
      assert length(rows) == 2

      by_slug = Map.new(rows, &{&1["slug"], &1})

      assert by_slug[net1.slug]["connection_state"] == "connected"
      assert by_slug[net1.slug]["nick"] != nil
      assert is_binary(by_slug[net1.slug]["connection_state_changed_at"])
      assert by_slug[net2.slug]["connection_state"] == "connected"
    end

    # Wire-parity invariant: the JSON shape of one row in `home_data.networks`
    # must equal the JSON shape of `connection_state_changed.network`
    # (REV-J M15 fold). Both flow through `Networks.Wire.home_network_row/2`,
    # so a future field addition lands in both consumers atomically. A
    # regression that builds one inline would surface here as a key/value
    # mismatch.
    test "envelope row JSON keys are structurally identical to the typed event's :network",
         %{conn: conn} do
      {user, session} = user_and_session()
      slug = "home-parity-#{System.unique_integer([:positive])}"
      {net, _} = network_with_server(port: 7404, slug: slug)
      _ = credential_fixture(user, net)

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/me")

      [row] = json_response(conn, 200)["home_data"]["networks"]

      cred =
        user
        |> Grappa.Networks.Credentials.list_credentials_for_user()
        |> hd()

      nick = Grappa.Networks.resolve_network_nick(user.id, cred)

      event =
        Grappa.Networks.Wire.connection_state_changed_event(
          cred,
          :connected,
          :connected,
          nil,
          nick
        )

      # Both producers must yield the same map structure once Jason-encoded.
      assert row == event.network |> Jason.encode!() |> Jason.decode!()
    end
  end

  # #157 — self-service account deletion. The HTTP contract + subject
  # routing + socket teardown. The teardown-ordering WITH live
  # Session.Servers (stop-before-wipe) is owned by the async:false
  # `Grappa.AccountDeletionTest`; here we assert the door, the gating, and
  # the cascade outcome without spawning a session (so this file stays
  # async:true).
  describe "DELETE /me — account deletion" do
    test "non-admin user → 204, account gone, auth session unusable, socket closed",
         %{conn: conn} do
      {user, session} = user_and_session()
      :ok = GrappaWeb.Endpoint.subscribe("user_socket:#{user.name}")

      conn
      |> put_bearer(session.id)
      |> delete("/me")
      |> response(204)

      assert Repo.get(User, user.id) == nil
      assert {:error, :not_found} = Accounts.authenticate(session.id)

      # Mid-flight WS enforcement: the transport's id-topic gets the
      # canonical "disconnect" so a deleted browser stops receiving fan-out.
      assert_receive %Phoenix.Socket.Broadcast{
                       topic: topic,
                       event: "disconnect",
                       payload: %{}
                     },
                     500

      assert topic == "user_socket:#{user.name}"
    end

    test "admin user → 403, the account is PRESERVED", %{conn: conn} do
      user = user_fixture(is_admin: true)
      session = session_fixture(user)

      conn
      |> put_bearer(session.id)
      |> delete("/me")
      |> json_response(403)

      assert %User{} = Repo.get(User, user.id)
      # Auth session still valid — nothing was torn down.
      assert {:ok, _} = Accounts.authenticate(session.id)
    end

    test "registered visitor → 204, the row is WIPED (delete ≠ quit, which preserves it)",
         %{conn: conn} do
      # The #126 boundary: `DELETE /auth/logout` (detach) PRESERVES a
      # registered visitor's row (asserted in auth_controller_test); the
      # self-delete door is the ONLY one that wipes it. Port 6667 has no
      # listener — no session is spawned (controller-contract test).
      {base, _} = visitor_with_network(6667)
      {:ok, _} = Visitors.commit_password(base.id, "s3cret")
      visitor = Repo.get!(Visitor, base.id)
      session = visitor_session_fixture(visitor)

      conn
      |> put_bearer(session.id)
      |> delete("/me")
      |> response(204)

      assert Repo.get(Visitor, visitor.id) == nil
      assert {:error, :not_found} = Accounts.authenticate(session.id)
    end

    test "anon visitor → 403 (quit-only; no persistent identity to delete)", %{conn: conn} do
      {visitor, session} = visitor_and_session()
      assert is_nil(Repo.get!(Visitor, visitor.id).password_encrypted)

      conn
      |> put_bearer(session.id)
      |> delete("/me")
      |> json_response(403)

      assert %Visitor{} = Repo.get(Visitor, visitor.id)
      assert {:ok, _} = Accounts.authenticate(session.id)
    end

    test "without Bearer → 401", %{conn: conn} do
      conn
      |> delete("/me")
      |> json_response(401)
    end
  end
end
