defmodule GrappaWeb.UserSettingsControllerTest do
  @moduledoc """
  REST surface for `Grappa.UserSettings` — push notifications cluster
  B3 (2026-05-14).

  First exposed accessor: `notification_prefs`. Two endpoints:
    * `GET /me/settings/notification-prefs` — falls back to defaults.
    * `PUT /me/settings/notification-prefs` — validates + persists.

  Coverage:
    * Auth gating: 401 without bearer; visitor returns 200 (V4 lift —
      previously 403 user-only).
    * GET happy path: defaults shape when never persisted.
    * GET reflects last PUT.
    * PUT happy path: 200 + persisted, normalized whitelist.
    * PUT validation: no-trigger-enabled rejected with 422 + field_errors.
    * PUT body shapes: bare prefs map AND wrapped under `notification_prefs`.
    * PUT preserves other settings keys (highlight_patterns interop).
    * Visitor parity (V4): GET + PUT both succeed; settings persist
      against the `{:visitor, uuid}` subject.
  """
  use GrappaWeb.ConnCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.UserSettings

  defp default_prefs_wire do
    %{
      "channel_messages_all" => false,
      "channel_messages_only" => [],
      "channel_mentions" => true,
      "private_messages_all" => true,
      "private_messages_only" => [],
      # #866 — nothing muted by default; the wire carries the key so a client
      # can tell "no mutes" from "a server that predates the field".
      "muted_targets" => %{}
    }
  end

  defp valid_prefs_wire(overrides \\ %{}) do
    Map.merge(default_prefs_wire(), overrides)
  end

  describe "GET /me/settings/notification-prefs — auth gating" do
    test "401 without bearer", %{conn: conn} do
      conn = get(conn, "/me/settings/notification-prefs")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "200 for a visitor subject — visitor-parity V4", %{conn: conn} do
      {_, session} = visitor_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/me/settings/notification-prefs")

      assert %{"notification_prefs" => prefs} = json_response(conn, 200)
      assert prefs == default_prefs_wire()
    end
  end

  describe "GET /me/settings/notification-prefs — happy path" do
    setup %{conn: conn} do
      {user, session} = user_and_session()
      {:ok, conn: put_bearer(conn, session.id), user: user}
    end

    test "returns defaults when user has never persisted prefs", %{conn: conn} do
      conn = get(conn, "/me/settings/notification-prefs")

      assert %{"notification_prefs" => prefs} = json_response(conn, 200)
      assert prefs == default_prefs_wire()
    end

    test "reflects the most-recent PUT", %{conn: conn, user: user} do
      {:ok, _} =
        UserSettings.put_notification_prefs({:user, user.id}, %{
          channel_messages_all: false,
          channel_messages_only: ["#sbiffo"],
          channel_mentions: true,
          private_messages_all: false,
          private_messages_only: ["alice"]
        })

      conn = get(conn, "/me/settings/notification-prefs")

      assert %{"notification_prefs" => prefs} = json_response(conn, 200)

      assert prefs == %{
               "channel_messages_all" => false,
               "channel_messages_only" => ["#sbiffo"],
               "channel_mentions" => true,
               "private_messages_all" => false,
               "private_messages_only" => ["alice"],
               "muted_targets" => %{}
             }
    end
  end

  describe "PUT /me/settings/notification-prefs — auth gating" do
    test "401 without bearer", %{conn: conn} do
      conn = put(conn, "/me/settings/notification-prefs", valid_prefs_wire())
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "200 + persisted for a visitor subject — visitor-parity V4", %{conn: conn} do
      {visitor, session} = visitor_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put("/me/settings/notification-prefs", valid_prefs_wire(%{"channel_messages_only" => ["#vis"]}))

      assert %{"notification_prefs" => returned} = json_response(conn, 200)
      assert returned["channel_messages_only"] == ["#vis"]

      stored = UserSettings.get_notification_prefs({:visitor, visitor.id})
      assert stored.channel_messages_only == ["#vis"]
    end
  end

  describe "PUT /me/settings/notification-prefs — happy path" do
    setup %{conn: conn} do
      {user, session} = user_and_session()
      {:ok, conn: put_bearer(conn, session.id), user: user}
    end

    test "200 + persisted prefs (bare body shape)", %{conn: conn, user: user} do
      body = valid_prefs_wire(%{"channel_messages_only" => ["#sbiffo"]})
      conn = put(conn, "/me/settings/notification-prefs", body)

      assert %{"notification_prefs" => returned} = json_response(conn, 200)
      assert returned["channel_messages_only"] == ["#sbiffo"]

      stored = UserSettings.get_notification_prefs({:user, user.id})
      assert stored.channel_messages_only == ["#sbiffo"]
    end

    test "lowercases + trims whitelist members on PUT", %{conn: conn, user: user} do
      body =
        valid_prefs_wire(%{
          "channel_messages_only" => ["  #SBIFFO ", "#Italia"],
          "private_messages_only" => ["Alice"]
        })

      conn = put(conn, "/me/settings/notification-prefs", body)

      assert %{"notification_prefs" => returned} = json_response(conn, 200)
      assert returned["channel_messages_only"] == ["#sbiffo", "#italia"]
      assert returned["private_messages_only"] == ["alice"]

      stored = UserSettings.get_notification_prefs({:user, user.id})
      assert stored.channel_messages_only == ["#sbiffo", "#italia"]
    end

    # #866 — the nested mute map has to survive the wire in BOTH directions.
    # Everything else in this envelope is a flat boolean or a list of strings;
    # this is the first key whose value is an object, so the atom-vs-string
    # round-trip through the `:map` column has one more level to get wrong.
    test "round-trips the nested muted_targets map, folded", %{conn: conn, user: user} do
      body = valid_prefs_wire(%{"muted_targets" => %{"#NOISY" => %{"until" => nil}}})
      conn = put(conn, "/me/settings/notification-prefs", body)

      assert %{"notification_prefs" => returned} = json_response(conn, 200)
      assert returned["muted_targets"] == %{"#noisy" => %{"until" => nil}}

      stored = UserSettings.get_notification_prefs({:user, user.id})
      assert stored.muted_targets == %{"#noisy" => %{"until" => nil}}
    end
  end

  describe "PUT /me/settings/notification-prefs — validation" do
    setup %{conn: conn} do
      {_, session} = user_and_session()
      {:ok, conn: put_bearer(conn, session.id)}
    end

    test "422 when no trigger is enabled", %{conn: conn} do
      body =
        valid_prefs_wire(%{
          "channel_mentions" => false,
          "private_messages_all" => false
        })

      conn = put(conn, "/me/settings/notification-prefs", body)

      assert %{"error" => "validation_failed", "field_errors" => fe} = json_response(conn, 422)
      assert is_map(fe)
      assert Map.has_key?(fe, "notification_prefs")
    end

    test "422 when a boolean field carries a non-boolean", %{conn: conn} do
      body = valid_prefs_wire(%{"channel_mentions" => "yes"})
      conn = put(conn, "/me/settings/notification-prefs", body)

      assert %{"error" => "validation_failed"} = json_response(conn, 422)
    end

    test "422 when a list field is not a list", %{conn: conn} do
      body = valid_prefs_wire(%{"channel_messages_only" => "#sbiffo"})
      conn = put(conn, "/me/settings/notification-prefs", body)

      assert %{"error" => "validation_failed"} = json_response(conn, 422)
    end
  end

  describe "PUT preserves other settings keys" do
    setup %{conn: conn} do
      {user, session} = user_and_session()
      {:ok, conn: put_bearer(conn, session.id), user: user}
    end

    test "highlight_patterns survives a notification_prefs PUT", %{conn: conn, user: user} do
      {:ok, _} = UserSettings.set_highlight_patterns({:user, user.id}, ["foo", "bar"])

      conn = put(conn, "/me/settings/notification-prefs", valid_prefs_wire())
      assert json_response(conn, 200)

      assert UserSettings.get_highlight_patterns({:user, user.id}) == ["foo", "bar"]
    end
  end

  # ---------------------------------------------------------------------------
  # upload_ttl_seconds — UX-4 bucket M (2026-05-19)
  # ---------------------------------------------------------------------------

  describe "GET /me/settings/upload-ttl-seconds — auth gating" do
    test "401 without bearer", %{conn: conn} do
      conn = get(conn, "/me/settings/upload-ttl-seconds")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "200 + null for an unset visitor (visitor-parity)", %{conn: conn} do
      {_, session} = visitor_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/me/settings/upload-ttl-seconds")

      assert json_response(conn, 200) == %{"upload_ttl_seconds" => nil}
    end
  end

  describe "GET /me/settings/upload-ttl-seconds — happy path" do
    setup %{conn: conn} do
      {user, session} = user_and_session()
      {:ok, conn: put_bearer(conn, session.id), user: user}
    end

    test "returns null when never persisted", %{conn: conn} do
      conn = get(conn, "/me/settings/upload-ttl-seconds")
      assert json_response(conn, 200) == %{"upload_ttl_seconds" => nil}
    end

    test "reflects the most-recent PUT", %{conn: conn, user: user} do
      {:ok, _} = UserSettings.put_upload_ttl_seconds({:user, user.id}, 86_400)

      conn = get(conn, "/me/settings/upload-ttl-seconds")
      assert json_response(conn, 200) == %{"upload_ttl_seconds" => 86_400}
    end
  end

  describe "PUT /me/settings/upload-ttl-seconds — auth gating" do
    test "401 without bearer", %{conn: conn} do
      conn = put(conn, "/me/settings/upload-ttl-seconds", %{"upload_ttl_seconds" => 3600})
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "200 + persisted for a visitor (visitor-parity)", %{conn: conn} do
      {visitor, session} = visitor_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put("/me/settings/upload-ttl-seconds", %{"upload_ttl_seconds" => 3600})

      assert json_response(conn, 200) == %{"upload_ttl_seconds" => 3600}
      assert UserSettings.get_upload_ttl_seconds({:visitor, visitor.id}) == 3600
    end
  end

  describe "PUT /me/settings/upload-ttl-seconds — happy path" do
    setup %{conn: conn} do
      {user, session} = user_and_session()
      {:ok, conn: put_bearer(conn, session.id), user: user}
    end

    test "200 + persisted for positive integer", %{conn: conn, user: user} do
      conn = put(conn, "/me/settings/upload-ttl-seconds", %{"upload_ttl_seconds" => 43_200})
      assert json_response(conn, 200) == %{"upload_ttl_seconds" => 43_200}
      assert UserSettings.get_upload_ttl_seconds({:user, user.id}) == 43_200
    end

    test "200 + cleared when body carries null", %{conn: conn, user: user} do
      {:ok, _} = UserSettings.put_upload_ttl_seconds({:user, user.id}, 3600)

      conn = put(conn, "/me/settings/upload-ttl-seconds", %{"upload_ttl_seconds" => nil})
      assert json_response(conn, 200) == %{"upload_ttl_seconds" => nil}
      assert UserSettings.get_upload_ttl_seconds({:user, user.id}) == nil
    end
  end

  describe "PUT /me/settings/upload-ttl-seconds — validation" do
    setup %{conn: conn} do
      {_, session} = user_and_session()
      {:ok, conn: put_bearer(conn, session.id)}
    end

    test "422 when value is zero", %{conn: conn} do
      conn = put(conn, "/me/settings/upload-ttl-seconds", %{"upload_ttl_seconds" => 0})
      assert %{"error" => "validation_failed"} = json_response(conn, 422)
    end

    test "422 when value is negative", %{conn: conn} do
      conn = put(conn, "/me/settings/upload-ttl-seconds", %{"upload_ttl_seconds" => -1})
      assert %{"error" => "validation_failed"} = json_response(conn, 422)
    end

    test "422 when value exceeds upper bound (1 year + 1s)", %{conn: conn} do
      conn =
        put(conn, "/me/settings/upload-ttl-seconds", %{"upload_ttl_seconds" => 31_536_001})

      assert %{"error" => "validation_failed"} = json_response(conn, 422)
    end

    test "400 when body is missing the key entirely", %{conn: conn} do
      conn = put(conn, "/me/settings/upload-ttl-seconds", %{})
      assert json_response(conn, 400) == %{"error" => "bad_request"}
    end

    test "400 when value is a string", %{conn: conn} do
      conn = put(conn, "/me/settings/upload-ttl-seconds", %{"upload_ttl_seconds" => "24h"})
      assert json_response(conn, 400) == %{"error" => "bad_request"}
    end
  end

  describe "upload_ttl_seconds — key isolation" do
    setup %{conn: conn} do
      {user, session} = user_and_session()
      {:ok, conn: put_bearer(conn, session.id), user: user}
    end

    test "notification_prefs survives an upload_ttl_seconds PUT", %{conn: conn, user: user} do
      {:ok, _} =
        UserSettings.put_notification_prefs({:user, user.id}, %{
          channel_messages_all: false,
          channel_messages_only: ["#sbiffo"],
          channel_mentions: true,
          private_messages_all: true,
          private_messages_only: []
        })

      conn = put(conn, "/me/settings/upload-ttl-seconds", %{"upload_ttl_seconds" => 3600})
      assert json_response(conn, 200)

      stored = UserSettings.get_notification_prefs({:user, user.id})
      assert stored.channel_messages_only == ["#sbiffo"]
    end
  end

  # ---------------------------------------------------------------------------
  # aliases — #385 user-defined command aliases
  # ---------------------------------------------------------------------------

  describe "GET /me/settings/aliases — auth gating" do
    test "401 without bearer", %{conn: conn} do
      conn = get(conn, "/me/settings/aliases")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "200 + {} for a visitor subject (visitor-parity)", %{conn: conn} do
      {_, session} = visitor_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/me/settings/aliases")

      assert json_response(conn, 200) == %{"aliases" => %{}}
    end
  end

  describe "GET /me/settings/aliases — happy path" do
    setup %{conn: conn} do
      {user, session} = user_and_session()
      {:ok, conn: put_bearer(conn, session.id), user: user}
    end

    test "returns empty map when never persisted", %{conn: conn} do
      conn = get(conn, "/me/settings/aliases")
      assert json_response(conn, 200) == %{"aliases" => %{}}
    end

    test "reflects the most-recent PUT", %{conn: conn, user: user} do
      {:ok, _} = UserSettings.set_aliases({:user, user.id}, %{"wii" => "whois $1 $1"})

      conn = get(conn, "/me/settings/aliases")
      assert json_response(conn, 200) == %{"aliases" => %{"wii" => "whois $1 $1"}}
    end
  end

  describe "PUT /me/settings/aliases — happy path" do
    setup %{conn: conn} do
      {user, session} = user_and_session()
      {:ok, conn: put_bearer(conn, session.id), user: user}
    end

    test "200 + persisted aliases (wrapped body)", %{conn: conn, user: user} do
      body = %{"aliases" => %{"WII" => "whois $1 $1"}}
      conn = put(conn, "/me/settings/aliases", body)

      # Server lowercases the name.
      assert %{"aliases" => returned} = json_response(conn, 200)
      assert returned == %{"wii" => "whois $1 $1"}

      assert UserSettings.get_aliases({:user, user.id}) == %{"wii" => "whois $1 $1"}
    end

    test "accepts an empty aliases map (clears all)", %{conn: conn, user: user} do
      {:ok, _} = UserSettings.set_aliases({:user, user.id}, %{"wii" => "whois $1 $1"})

      conn = put(conn, "/me/settings/aliases", %{"aliases" => %{}})
      assert json_response(conn, 200) == %{"aliases" => %{}}
      assert UserSettings.get_aliases({:user, user.id}) == %{}
    end
  end

  describe "PUT /me/settings/aliases — validation + bad shape" do
    setup %{conn: conn} do
      {_, session} = user_and_session()
      {:ok, conn: put_bearer(conn, session.id)}
    end

    test "422 + field_errors.aliases when a name contains whitespace", %{conn: conn} do
      conn = put(conn, "/me/settings/aliases", %{"aliases" => %{"wi i" => "whois"}})

      assert %{"error" => "validation_failed", "field_errors" => fe} = json_response(conn, 422)
      assert Map.has_key?(fe, "aliases")
    end

    test "422 when an expansion is empty", %{conn: conn} do
      conn = put(conn, "/me/settings/aliases", %{"aliases" => %{"wii" => "   "}})
      assert %{"error" => "validation_failed"} = json_response(conn, 422)
    end

    test "400 when the body has no aliases key", %{conn: conn} do
      conn = put(conn, "/me/settings/aliases", %{"nope" => %{}})
      assert json_response(conn, 400) == %{"error" => "bad_request"}
    end

    test "400 when aliases is not a map", %{conn: conn} do
      conn = put(conn, "/me/settings/aliases", %{"aliases" => ["not", "a", "map"]})
      assert json_response(conn, 400) == %{"error" => "bad_request"}
    end
  end

  describe "PUT /me/settings/aliases — visitor parity + key isolation" do
    test "200 + persisted for a visitor subject", %{conn: conn} do
      {visitor, session} = visitor_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put("/me/settings/aliases", %{"aliases" => %{"wii" => "whois $1 $1"}})

      assert %{"aliases" => %{"wii" => "whois $1 $1"}} = json_response(conn, 200)
      assert UserSettings.get_aliases({:visitor, visitor.id}) == %{"wii" => "whois $1 $1"}
    end

    test "highlight_patterns survives an aliases PUT", %{conn: conn} do
      {user, session} = user_and_session()
      {:ok, _} = UserSettings.set_highlight_patterns({:user, user.id}, ["foo", "bar"])

      conn =
        conn
        |> put_bearer(session.id)
        |> put("/me/settings/aliases", %{"aliases" => %{"wii" => "whois $1 $1"}})

      assert json_response(conn, 200)
      assert UserSettings.get_highlight_patterns({:user, user.id}) == ["foo", "bar"]
    end
  end

  # ===========================================================================
  # display_prefs (#449) — server-backed display preferences, so one account
  # converges its UI across devices. Wrapped-envelope endpoint mirroring
  # aliases; full-map PUT, no PATCH/diff. Three prefs: time_format,
  # colored_nicklist, presence_filter (per-channel tri-state map).
  #
  # A/B-INDEPENDENT core: font-size (Fork A, escalated to vjt) and the
  # client-side seed-up-once migration (Fork B) are NOT exercised here.
  # ===========================================================================

  # The default display-prefs wire shape (string keys, as JSON delivers them).
  defp default_display_prefs_wire do
    %{
      "time_format" => "hms",
      "colored_nicklist" => false,
      "presence_filter" => %{}
    }
  end

  describe "GET /me/settings/display-prefs — auth gating" do
    test "401 without bearer", %{conn: conn} do
      conn = get(conn, "/me/settings/display-prefs")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "200 defaults for a visitor subject — visitor parity", %{conn: conn} do
      {_, session} = visitor_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/me/settings/display-prefs")

      assert %{"display_prefs" => prefs} = json_response(conn, 200)
      assert prefs == default_display_prefs_wire()
    end
  end

  describe "GET /me/settings/display-prefs — happy path" do
    setup %{conn: conn} do
      {user, session} = user_and_session()
      {:ok, conn: put_bearer(conn, session.id), user: user}
    end

    test "returns defaults when never persisted", %{conn: conn} do
      conn = get(conn, "/me/settings/display-prefs")
      assert %{"display_prefs" => prefs} = json_response(conn, 200)
      assert prefs == default_display_prefs_wire()
    end

    test "reflects the most-recent PUT", %{conn: conn, user: user} do
      {:ok, _} =
        UserSettings.put_display_prefs({:user, user.id}, %{
          "time_format" => "hm",
          "colored_nicklist" => true,
          "presence_filter" => %{"libera #bofh" => "hide"}
        })

      conn = get(conn, "/me/settings/display-prefs")

      assert %{"display_prefs" => prefs} = json_response(conn, 200)

      assert prefs == %{
               "time_format" => "hm",
               "colored_nicklist" => true,
               "presence_filter" => %{"libera #bofh" => "hide"}
             }
    end

    test "carries persisted:false when never written (seed-up discriminator)", %{conn: conn} do
      conn = get(conn, "/me/settings/display-prefs")
      assert %{"persisted" => false} = json_response(conn, 200)
    end

    test "carries persisted:true after a write", %{conn: conn, user: user} do
      {:ok, _} =
        UserSettings.put_display_prefs({:user, user.id}, %{
          "time_format" => "hm",
          "colored_nicklist" => false,
          "presence_filter" => %{}
        })

      conn = get(conn, "/me/settings/display-prefs")
      assert %{"persisted" => true} = json_response(conn, 200)
    end
  end

  describe "PUT /me/settings/display-prefs — happy path" do
    setup %{conn: conn} do
      {user, session} = user_and_session()
      {:ok, conn: put_bearer(conn, session.id), user: user}
    end

    test "200 + persisted (wrapped body)", %{conn: conn, user: user} do
      body = %{
        "display_prefs" => %{
          "time_format" => "hm",
          "colored_nicklist" => true,
          "presence_filter" => %{"libera #cat" => "show"}
        }
      }

      conn = put(conn, "/me/settings/display-prefs", body)

      assert %{"display_prefs" => returned} = json_response(conn, 200)
      assert returned["time_format"] == "hm"
      assert returned["colored_nicklist"] == true
      assert returned["presence_filter"] == %{"libera #cat" => "show"}

      stored = UserSettings.get_display_prefs({:user, user.id})
      assert stored.time_format == "hm"
      assert stored.presence_filter == %{"libera #cat" => "show"}
    end

    test "PUT response carries persisted:true", %{conn: conn} do
      conn = put(conn, "/me/settings/display-prefs", %{"display_prefs" => default_display_prefs_wire()})
      assert %{"persisted" => true} = json_response(conn, 200)
    end

    test "tri-state survives the HTTP round-trip — unset stays ABSENT (NON-NEGOTIABLE)",
         %{conn: conn} do
      # Only #a is pinned; #b is never mentioned (unset — follows the size
      # default client-side). The server must not coerce #b into the map.
      body = %{
        "display_prefs" => %{
          "time_format" => "hms",
          "colored_nicklist" => false,
          "presence_filter" => %{"n #a" => "hide"}
        }
      }

      conn = put(conn, "/me/settings/display-prefs", body)

      assert %{"display_prefs" => %{"presence_filter" => pf}} = json_response(conn, 200)
      assert pf == %{"n #a" => "hide"}
      refute Map.has_key?(pf, "n #b")
    end

    test "empty presence_filter clears all pins (full-map PUT semantics)", %{conn: conn, user: user} do
      {:ok, _} =
        UserSettings.put_display_prefs({:user, user.id}, %{
          "time_format" => "hms",
          "colored_nicklist" => false,
          "presence_filter" => %{"n #a" => "hide"}
        })

      conn = put(conn, "/me/settings/display-prefs", %{"display_prefs" => default_display_prefs_wire()})

      assert %{"display_prefs" => %{"presence_filter" => pf}} = json_response(conn, 200)
      assert pf == %{}
    end
  end

  describe "PUT /me/settings/display-prefs — validation + bad shape" do
    setup %{conn: conn} do
      {_, session} = user_and_session()
      {:ok, conn: put_bearer(conn, session.id)}
    end

    test "422 + field_errors.display_prefs for an unknown time_format", %{conn: conn} do
      body = %{"display_prefs" => Map.put(default_display_prefs_wire(), "time_format", "iso8601")}
      conn = put(conn, "/me/settings/display-prefs", body)

      assert %{"error" => "validation_failed", "field_errors" => fe} = json_response(conn, 422)
      assert Map.has_key?(fe, "display_prefs")
    end

    test "422 for a presence value that is neither show nor hide", %{conn: conn} do
      body = %{"display_prefs" => Map.put(default_display_prefs_wire(), "presence_filter", %{"n #a" => "maybe"})}
      conn = put(conn, "/me/settings/display-prefs", body)

      assert %{"error" => "validation_failed"} = json_response(conn, 422)
    end

    test "400 when the body has no display_prefs key", %{conn: conn} do
      conn = put(conn, "/me/settings/display-prefs", %{"nope" => %{}})
      assert json_response(conn, 400) == %{"error" => "bad_request"}
    end

    test "400 when display_prefs is not a map", %{conn: conn} do
      conn = put(conn, "/me/settings/display-prefs", %{"display_prefs" => ["not", "a", "map"]})
      assert json_response(conn, 400) == %{"error" => "bad_request"}
    end
  end

  describe "PUT /me/settings/display-prefs — visitor parity + key isolation" do
    test "200 + persisted for a visitor subject", %{conn: conn} do
      {visitor, session} = visitor_and_session()

      conn =
        conn
        |> put_bearer(session.id)
        |> put("/me/settings/display-prefs", %{
          "display_prefs" => Map.put(default_display_prefs_wire(), "presence_filter", %{"n #v" => "hide"})
        })

      assert %{"display_prefs" => %{"presence_filter" => %{"n #v" => "hide"}}} = json_response(conn, 200)
      assert UserSettings.get_display_prefs({:visitor, visitor.id}).presence_filter == %{"n #v" => "hide"}
    end

    test "highlight_patterns survives a display_prefs PUT", %{conn: conn} do
      {user, session} = user_and_session()
      {:ok, _} = UserSettings.set_highlight_patterns({:user, user.id}, ["foo", "bar"])

      conn =
        conn
        |> put_bearer(session.id)
        |> put("/me/settings/display-prefs", %{"display_prefs" => default_display_prefs_wire()})

      assert json_response(conn, 200)
      assert UserSettings.get_highlight_patterns({:user, user.id}) == ["foo", "bar"]
    end
  end
end
