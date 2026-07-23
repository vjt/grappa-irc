defmodule Grappa.ServerSettingsTest do
  use Grappa.DataCase, async: true

  alias Grappa.ServerSettings
  alias Grappa.ServerSettings.Setting

  describe "defaults — sane out-of-the-box" do
    test "get_upload_active_host/0 defaults to :embedded" do
      assert ServerSettings.get_upload_active_host() == :embedded
    end

    test "get_upload_global_cap_bytes/0 defaults to 10 GiB" do
      assert ServerSettings.get_upload_global_cap_bytes() == 10 * 1024 * 1024 * 1024
    end

    test "public_view/0 returns defaults under :upload" do
      view = ServerSettings.public_view()
      assert view.upload.active_host == :embedded
      assert view.upload.image_per_file_cap_bytes == 10 * 1024 * 1024
      assert view.upload.video_per_file_cap_bytes == 50 * 1024 * 1024
      assert view.upload.document_per_file_cap_bytes == 10 * 1024 * 1024
      assert view.upload.global_cap_bytes == 10 * 1024 * 1024 * 1024
      # #324 — the deployment HTTP host alias set is always present (a
      # list; empty when no PHX_HOST is configured, as in test env).
      assert is_list(view.http_host_aliases)
    end
  end

  describe "public_view/0 — http_host_aliases (#324)" do
    setup do
      # Snapshot + restore the process-global persistent_term so a
      # stashed set doesn't leak into sibling tests (max_cases: 1
      # serializes, but restore keeps this hermetic regardless).
      prior = Grappa.HttpHosts.aliases()
      on_exit(fn -> :ok = Grappa.HttpHosts.boot(prior) end)
      :ok
    end

    test "reflects the deployment's HttpHosts alias set" do
      :ok = Grappa.HttpHosts.boot(["irc.sindro.me", "irc.sniffo.org"])
      assert ServerSettings.public_view().http_host_aliases == ["irc.sindro.me", "irc.sniffo.org"]
    end

    test "is an empty list when no aliases are configured" do
      :ok = Grappa.HttpHosts.boot([])
      assert ServerSettings.public_view().http_host_aliases == []
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

  describe "per-type per-file caps" do
    test "defaults: image 10MiB, video 50MiB, document 10MiB, audio 25MiB" do
      assert ServerSettings.get_upload_per_file_cap_bytes(:image) == 10 * 1024 * 1024
      assert ServerSettings.get_upload_per_file_cap_bytes(:video) == 50 * 1024 * 1024
      assert ServerSettings.get_upload_per_file_cap_bytes(:document) == 10 * 1024 * 1024
      assert ServerSettings.get_upload_per_file_cap_bytes(:audio) == 25 * 1024 * 1024
    end

    test "put/get roundtrip per category, others untouched" do
      assert :ok = ServerSettings.put_upload_per_file_cap_bytes(:video, 25 * 1024 * 1024)
      assert ServerSettings.get_upload_per_file_cap_bytes(:video) == 25 * 1024 * 1024
      assert ServerSettings.get_upload_per_file_cap_bytes(:image) == 10 * 1024 * 1024
    end

    test "audio put/get roundtrip, others untouched" do
      assert :ok = ServerSettings.put_upload_per_file_cap_bytes(:audio, 30 * 1024 * 1024)
      assert ServerSettings.get_upload_per_file_cap_bytes(:audio) == 30 * 1024 * 1024
      assert ServerSettings.get_upload_per_file_cap_bytes(:image) == 10 * 1024 * 1024
    end

    test "rejects invalid category and non-positive values" do
      assert {:error, :invalid_value} = ServerSettings.put_upload_per_file_cap_bytes(:image, 0)
      assert {:error, :invalid_value} = ServerSettings.put_upload_per_file_cap_bytes(:image, -1)
      assert {:error, :invalid_value} = ServerSettings.put_upload_per_file_cap_bytes(:audio, 0)
      # A genuinely-unknown category stays rejected at the closed-set boundary.
      assert {:error, :invalid_value} = ServerSettings.put_upload_per_file_cap_bytes(:sticker, 1)

      assert {:error, :invalid_value} =
               ServerSettings.put_upload_per_file_cap_bytes(:image, "5000000")
    end

    test "public_view carries the four cap fields" do
      assert %{
               upload: %{
                 image_per_file_cap_bytes: _,
                 video_per_file_cap_bytes: _,
                 document_per_file_cap_bytes: _,
                 audio_per_file_cap_bytes: _,
                 active_host: _,
                 global_cap_bytes: _
               }
             } = ServerSettings.public_view()
    end

    test "old single key is NOT read (no fallback — total migration)" do
      Repo.insert!(%Setting{key: "upload.per_file_cap_bytes", value: "999"})
      assert ServerSettings.get_upload_per_file_cap_bytes(:image) == 10 * 1024 * 1024
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

    test "broadcasts server_settings_changed on put_upload_active_host" do
      :ok = ServerSettings.put_upload_active_host(:litterbox)

      assert_receive %Phoenix.Socket.Broadcast{
        event: "event",
        payload: %{kind: :server_settings_changed, upload: %{active_host: :litterbox}}
      }
    end

    test "broadcasts server_settings_changed on put_upload_per_file_cap_bytes" do
      :ok = ServerSettings.put_upload_per_file_cap_bytes(:video, 7_777_777)

      assert_receive %Phoenix.Socket.Broadcast{
        event: "event",
        payload: %{
          kind: :server_settings_changed,
          upload: %{video_per_file_cap_bytes: 7_777_777}
        }
      }
    end

    test "broadcasts server_settings_changed on put_upload_global_cap_bytes" do
      :ok = ServerSettings.put_upload_global_cap_bytes(99_999)

      assert_receive %Phoenix.Socket.Broadcast{
        event: "event",
        payload: %{kind: :server_settings_changed, upload: %{global_cap_bytes: 99_999}}
      }
    end

    test "broadcasts server_settings_changed on put_upload_per_file_cap_bytes(:audio)" do
      :ok = ServerSettings.put_upload_per_file_cap_bytes(:audio, 7_654_321)

      assert_receive %Phoenix.Socket.Broadcast{
        event: "event",
        payload: %{
          kind: :server_settings_changed,
          upload: %{audio_per_file_cap_bytes: 7_654_321}
        }
      }
    end

    test "does NOT broadcast on rejected value" do
      ServerSettings.put_upload_active_host(:bogus)
      refute_receive %Phoenix.Socket.Broadcast{event: "event"}, 50
    end
  end

  describe "topic/0" do
    test "returns the canonical PubSub topic enumerated by Topic.parse/1" do
      topic = ServerSettings.topic()
      assert topic == Grappa.PubSub.Topic.server_settings()
      assert {:ok, :server_settings} = Grappa.PubSub.Topic.parse(topic)
    end
  end
end
