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
      "private_messages_only" => []
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
               "private_messages_only" => ["alice"]
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
end
