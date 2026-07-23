defmodule GrappaWeb.Admin.SettingsControllerTest do
  use GrappaWeb.ConnCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.PubSub.Topic
  alias Grappa.{ServerSettings, WSPresence}

  describe "GET /admin/settings — gate" do
    test "401 without bearer", %{conn: conn} do
      conn = get(conn, "/admin/settings")
      assert json_response(conn, 401) == %{"error" => "unauthorized"}
    end

    test "403 for non-admin user", %{conn: conn} do
      {_, session} = user_and_session([])

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/admin/settings")

      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end

    test "403 for visitor", %{conn: conn} do
      {_, session} = visitor_and_session([])

      conn =
        conn
        |> put_bearer(session.id)
        |> get("/admin/settings")

      assert json_response(conn, 403) == %{"error" => "forbidden"}
    end
  end

  describe "GET /admin/settings — happy" do
    setup do
      {admin, session} = user_and_session(is_admin: true)
      %{admin: admin, session: session}
    end

    test "returns current settings", %{conn: conn, session: session} do
      conn = conn |> put_bearer(session.id) |> get("/admin/settings")
      assert %{"settings" => %{"upload" => upload}} = json_response(conn, 200)
      assert upload["active_host"] == "embedded"
      assert upload["image_per_file_cap_bytes"] == 10 * 1024 * 1024
      assert upload["video_per_file_cap_bytes"] == 50 * 1024 * 1024
      assert upload["document_per_file_cap_bytes"] == 10 * 1024 * 1024
      assert upload["audio_per_file_cap_bytes"] == 25 * 1024 * 1024
      assert upload["global_cap_bytes"] == 10 * 1024 * 1024 * 1024
    end
  end

  describe "PUT /admin/settings — happy" do
    setup do
      {admin, session} = user_and_session(is_admin: true)
      %{admin: admin, session: session}
    end

    test "updates upload.active_host", %{conn: conn, session: session} do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"active_host" => "litterbox"}})

      assert %{"settings" => %{"upload" => %{"active_host" => "litterbox"}}} =
               json_response(conn, 200)

      assert ServerSettings.get_upload_active_host() == :litterbox
    end

    test "updates image_per_file_cap_bytes", %{conn: conn, session: session} do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"image_per_file_cap_bytes" => 5_000_000}})

      assert %{"settings" => %{"upload" => %{"image_per_file_cap_bytes" => 5_000_000}}} =
               json_response(conn, 200)

      assert ServerSettings.get_upload_per_file_cap_bytes(:image) == 5_000_000
    end

    test "updates video_per_file_cap_bytes", %{conn: conn, session: session} do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"video_per_file_cap_bytes" => 25_000_000}})

      assert %{"settings" => %{"upload" => %{"video_per_file_cap_bytes" => 25_000_000}}} =
               json_response(conn, 200)

      assert ServerSettings.get_upload_per_file_cap_bytes(:video) == 25_000_000
    end

    test "updates document_per_file_cap_bytes", %{conn: conn, session: session} do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"document_per_file_cap_bytes" => 7_000_000}})

      assert %{"settings" => %{"upload" => %{"document_per_file_cap_bytes" => 7_000_000}}} =
               json_response(conn, 200)

      assert ServerSettings.get_upload_per_file_cap_bytes(:document) == 7_000_000
    end

    test "updates audio_per_file_cap_bytes", %{conn: conn, session: session} do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"audio_per_file_cap_bytes" => 30_000_000}})

      assert %{"settings" => %{"upload" => %{"audio_per_file_cap_bytes" => 30_000_000}}} =
               json_response(conn, 200)

      assert ServerSettings.get_upload_per_file_cap_bytes(:audio) == 30_000_000
    end

    test "updates global_cap_bytes", %{conn: conn, session: session} do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"global_cap_bytes" => 999_999}})

      assert %{"settings" => %{"upload" => %{"global_cap_bytes" => 999_999}}} =
               json_response(conn, 200)
    end

    test "ignores empty body", %{conn: conn, session: session} do
      conn = conn |> put_bearer(session.id) |> put("/admin/settings", %{})
      assert %{"settings" => _} = json_response(conn, 200)
    end

    test "ignores unknown keys", %{conn: conn, session: session} do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"unknown_key" => "foo"}})

      assert %{"settings" => _} = json_response(conn, 200)
    end
  end

  describe "PUT /admin/settings — validation" do
    setup do
      {_, session} = user_and_session(is_admin: true)
      %{session: session}
    end

    test "422 invalid_setting for unknown active_host", %{conn: conn, session: session} do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"active_host" => "imgbb"}})

      assert json_response(conn, 422) == %{
               "error" => "invalid_setting",
               "field" => "upload.active_host"
             }
    end

    test "422 invalid_setting for non-positive image_per_file_cap_bytes", %{
      conn: conn,
      session: session
    } do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"image_per_file_cap_bytes" => 0}})

      assert json_response(conn, 422) == %{
               "error" => "invalid_setting",
               "field" => "upload.image_per_file_cap_bytes"
             }
    end

    test "422 invalid_setting for negative video_per_file_cap_bytes", %{
      conn: conn,
      session: session
    } do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"video_per_file_cap_bytes" => -1}})

      assert json_response(conn, 422) == %{
               "error" => "invalid_setting",
               "field" => "upload.video_per_file_cap_bytes"
             }
    end

    test "422 invalid_setting for string document_per_file_cap_bytes", %{
      conn: conn,
      session: session
    } do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"document_per_file_cap_bytes" => "5000000"}})

      assert json_response(conn, 422) == %{
               "error" => "invalid_setting",
               "field" => "upload.document_per_file_cap_bytes"
             }
    end

    test "422 invalid_setting for zero audio_per_file_cap_bytes", %{
      conn: conn,
      session: session
    } do
      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"audio_per_file_cap_bytes" => 0}})

      assert json_response(conn, 422) == %{
               "error" => "invalid_setting",
               "field" => "upload.audio_per_file_cap_bytes"
             }
    end
  end

  describe "PUT /admin/settings — fan-out (UX-6-B2)" do
    setup do
      {_, session} = user_and_session(is_admin: true)
      %{session: session}
    end

    test "broadcasts server_settings_changed to subscribed user-topics", %{
      conn: conn,
      session: session
    } do
      # Same shape as `AdminControllerTest`'s cic_bundle_changed
      # broadcast assertion: register a fake socket pid so
      # `WSPresence.list_user_names/0` returns this user, then
      # subscribe a test process to the user-topic so we can observe
      # the fan-out.
      user_name = "settingsbcast-#{System.unique_integer([:positive])}"
      :ok = WSPresence.register(user_name, self())

      topic = Topic.user(user_name)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, topic)

      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"active_host" => "litterbox"}})

      assert json_response(conn, 200)

      assert_receive %Phoenix.Socket.Broadcast{
        event: "event",
        payload: %{
          kind: :server_settings_changed,
          upload: %{active_host: :litterbox}
        }
      }
    end

    test "broadcasts to VISITOR user-topics too (visitor cic also reads upload settings)",
         %{conn: conn, session: session} do
      visitor_name = "visitor:#{Ecto.UUID.generate()}"
      :ok = WSPresence.register(visitor_name, self())

      topic = Topic.user(visitor_name)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, topic)

      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"image_per_file_cap_bytes" => 4_000_000}})

      assert json_response(conn, 200)

      assert_receive %Phoenix.Socket.Broadcast{
        event: "event",
        payload: %{
          kind: :server_settings_changed,
          upload: %{image_per_file_cap_bytes: 4_000_000}
        }
      }
    end

    test "emits [:grappa, :admin, :server_settings_fanout] telemetry", %{
      conn: conn,
      session: session
    } do
      handler_id = "test-server-settings-fanout-#{System.unique_integer([:positive])}"
      parent = self()

      :telemetry.attach(
        handler_id,
        [:grappa, :admin, :server_settings_fanout],
        fn event, measurements, metadata, _ ->
          send(parent, {:telemetry, event, measurements, metadata})
        end,
        nil
      )

      try do
        user_name = "fanout-set-tel-#{System.unique_integer([:positive])}"
        :ok = WSPresence.register(user_name, self())

        conn =
          conn
          |> put_bearer(session.id)
          |> put("/admin/settings", %{"upload" => %{"global_cap_bytes" => 88_888}})

        assert json_response(conn, 200)

        assert_receive {:telemetry, [:grappa, :admin, :server_settings_fanout],
                        %{attempted: attempted, succeeded: succeeded, failed: failed}, _}

        assert is_integer(attempted)
        assert is_integer(succeeded)
        assert is_integer(failed)
        assert attempted >= 1
        assert succeeded + failed == attempted
      after
        :telemetry.detach(handler_id)
      end
    end

    test "does NOT fan out on validation failure", %{conn: conn, session: session} do
      user_name = "settingsbcast-novfail-#{System.unique_integer([:positive])}"
      :ok = WSPresence.register(user_name, self())

      topic = Topic.user(user_name)
      :ok = Phoenix.PubSub.subscribe(Grappa.PubSub, topic)

      conn =
        conn
        |> put_bearer(session.id)
        |> put("/admin/settings", %{"upload" => %{"active_host" => "imgbb"}})

      assert json_response(conn, 422)
      refute_receive %Phoenix.Socket.Broadcast{event: "event"}, 50
    end
  end
end
