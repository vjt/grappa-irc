defmodule Grappa.ServerSettingsTest do
  use Grappa.DataCase, async: true

  alias Grappa.ServerSettings

  describe "defaults — sane out-of-the-box" do
    test "get_upload_active_host/0 defaults to :embedded" do
      assert ServerSettings.get_upload_active_host() == :embedded
    end

    test "get_upload_per_file_cap_bytes/0 defaults to 10 MiB" do
      assert ServerSettings.get_upload_per_file_cap_bytes() == 10 * 1024 * 1024
    end

    test "get_upload_global_cap_bytes/0 defaults to 10 GiB" do
      assert ServerSettings.get_upload_global_cap_bytes() == 10 * 1024 * 1024 * 1024
    end

    test "public_view/0 returns defaults under :upload" do
      view = ServerSettings.public_view()
      assert view.upload.active_host == :embedded
      assert view.upload.per_file_cap_bytes == 10 * 1024 * 1024
      assert view.upload.global_cap_bytes == 10 * 1024 * 1024 * 1024
    end
  end

  describe "put_upload_active_host/1" do
    test "accepts :embedded" do
      assert :ok = ServerSettings.put_upload_active_host(:embedded)
      assert ServerSettings.get_upload_active_host() == :embedded
    end

    test "accepts :litterbox" do
      assert :ok = ServerSettings.put_upload_active_host(:litterbox)
      assert ServerSettings.get_upload_active_host() == :litterbox
    end

    test "rejects unknown atoms" do
      assert {:error, :invalid_value} = ServerSettings.put_upload_active_host(:imgbb)
    end

    test "rejects strings" do
      assert {:error, :invalid_value} = ServerSettings.put_upload_active_host("embedded")
    end

    test "round-trips :litterbox → :embedded" do
      :ok = ServerSettings.put_upload_active_host(:litterbox)
      :ok = ServerSettings.put_upload_active_host(:embedded)
      assert ServerSettings.get_upload_active_host() == :embedded
    end
  end

  describe "put_upload_per_file_cap_bytes/1" do
    test "accepts positive integer" do
      assert :ok = ServerSettings.put_upload_per_file_cap_bytes(5_000_000)
      assert ServerSettings.get_upload_per_file_cap_bytes() == 5_000_000
    end

    test "rejects zero" do
      assert {:error, :invalid_value} = ServerSettings.put_upload_per_file_cap_bytes(0)
    end

    test "rejects negative" do
      assert {:error, :invalid_value} = ServerSettings.put_upload_per_file_cap_bytes(-1)
    end

    test "rejects non-integer" do
      assert {:error, :invalid_value} = ServerSettings.put_upload_per_file_cap_bytes("5000000")
      assert {:error, :invalid_value} = ServerSettings.put_upload_per_file_cap_bytes(nil)
    end
  end

  describe "put_upload_global_cap_bytes/1" do
    test "accepts positive integer" do
      assert :ok = ServerSettings.put_upload_global_cap_bytes(20 * 1024 * 1024 * 1024)
      assert ServerSettings.get_upload_global_cap_bytes() == 20 * 1024 * 1024 * 1024
    end

    test "rejects zero" do
      assert {:error, :invalid_value} = ServerSettings.put_upload_global_cap_bytes(0)
    end

    test "rejects non-positive" do
      assert {:error, :invalid_value} = ServerSettings.put_upload_global_cap_bytes(-1)
    end
  end

  describe "PubSub broadcast on change" do
    setup do
      Phoenix.PubSub.subscribe(Grappa.PubSub, ServerSettings.topic())
      :ok
    end

    test "broadcasts :server_settings_changed on put_upload_active_host" do
      :ok = ServerSettings.put_upload_active_host(:litterbox)
      assert_receive {:server_settings_changed, view}
      assert view.upload.active_host == :litterbox
    end

    test "broadcasts :server_settings_changed on put_upload_per_file_cap_bytes" do
      :ok = ServerSettings.put_upload_per_file_cap_bytes(7_777_777)
      assert_receive {:server_settings_changed, view}
      assert view.upload.per_file_cap_bytes == 7_777_777
    end

    test "broadcasts :server_settings_changed on put_upload_global_cap_bytes" do
      :ok = ServerSettings.put_upload_global_cap_bytes(99_999)
      assert_receive {:server_settings_changed, view}
      assert view.upload.global_cap_bytes == 99_999
    end

    test "does NOT broadcast on rejected value" do
      ServerSettings.put_upload_active_host(:bogus)
      refute_receive {:server_settings_changed, _}, 50
    end
  end

  describe "topic/0" do
    test "returns the PubSub topic for settings-changed broadcasts" do
      assert is_binary(ServerSettings.topic())
      assert String.starts_with?(ServerSettings.topic(), "grappa:")
    end
  end
end
