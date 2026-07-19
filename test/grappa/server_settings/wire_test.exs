defmodule Grappa.ServerSettings.WireTest do
  use ExUnit.Case, async: true

  alias Grappa.ServerSettings.Wire

  # A full public_view fixture — upload subtree + the #324
  # http_host_aliases the wire builder now requires. Both params
  # explicit (CLAUDE.md: no default args).
  defp view(active_host, aliases) do
    %{
      upload: %{
        active_host: active_host,
        image_per_file_cap_bytes: 10_485_760,
        video_per_file_cap_bytes: 52_428_800,
        document_per_file_cap_bytes: 10_485_760,
        audio_per_file_cap_bytes: 26_214_400,
        global_cap_bytes: 10_737_418_240
      },
      http_host_aliases: aliases
    }
  end

  describe "server_settings_changed/1 — wire shape" do
    test "passes embedded host atom through (Jason stringifies at the edge)" do
      payload = Wire.server_settings_changed(view(:embedded, ["irc.sindro.me"]))

      assert payload.kind == "server_settings_changed"
      # S15: the host atom passes through the term unchanged; the Jason
      # boundary (see the encodable test below) stringifies it to
      # "embedded" so the wire bytes are identical.
      assert payload.upload.active_host == :embedded
      assert payload.upload.image_per_file_cap_bytes == 10_485_760
      assert payload.upload.video_per_file_cap_bytes == 52_428_800
      assert payload.upload.document_per_file_cap_bytes == 10_485_760
      assert payload.upload.audio_per_file_cap_bytes == 26_214_400
      assert payload.upload.global_cap_bytes == 10_737_418_240
    end

    test "passes litterbox host atom through" do
      payload = Wire.server_settings_changed(view(:litterbox, ["irc.sindro.me"]))

      assert payload.upload.active_host == :litterbox
      assert payload.upload.image_per_file_cap_bytes == 10_485_760
      assert payload.upload.global_cap_bytes == 10_737_418_240
    end

    test "carries the #324 http_host_aliases list through unchanged" do
      payload = Wire.server_settings_changed(view(:embedded, ["irc.sindro.me", "irc.sniffo.org"]))
      assert payload.http_host_aliases == ["irc.sindro.me", "irc.sniffo.org"]
    end

    test "an empty alias set is a valid payload (single-host / no PHX_HOST deployment)" do
      payload = Wire.server_settings_changed(view(:embedded, []))
      assert payload.http_host_aliases == []
    end

    test "payload is Jason-encodable (no atom values other than keys), aliases survive" do
      payload = Wire.server_settings_changed(view(:embedded, ["irc.sindro.me"]))
      decoded = payload |> Jason.encode!() |> Jason.decode!()

      assert decoded["kind"] == "server_settings_changed"
      assert decoded["upload"]["active_host"] == "embedded"
      assert decoded["upload"]["audio_per_file_cap_bytes"] == 26_214_400
      assert decoded["http_host_aliases"] == ["irc.sindro.me"]
    end

    test "kind field is the discriminator cic dispatches on" do
      assert %{kind: "server_settings_changed"} =
               Wire.server_settings_changed(view(:embedded, ["irc.sindro.me"]))
    end
  end

  describe "upload_view/1 — shared atom-through projection" do
    test "renders embedded with explicit field set" do
      assert %{
               active_host: :embedded,
               image_per_file_cap_bytes: 10_485_760,
               video_per_file_cap_bytes: 52_428_800,
               document_per_file_cap_bytes: 10_485_760,
               audio_per_file_cap_bytes: 26_214_400,
               global_cap_bytes: 10_737_418_240
             } =
               Wire.upload_view(%{
                 active_host: :embedded,
                 image_per_file_cap_bytes: 10_485_760,
                 video_per_file_cap_bytes: 52_428_800,
                 document_per_file_cap_bytes: 10_485_760,
                 audio_per_file_cap_bytes: 26_214_400,
                 global_cap_bytes: 10_737_418_240
               })
    end

    test "renders litterbox" do
      assert %{active_host: :litterbox} =
               Wire.upload_view(%{
                 active_host: :litterbox,
                 image_per_file_cap_bytes: 1,
                 video_per_file_cap_bytes: 2,
                 document_per_file_cap_bytes: 3,
                 audio_per_file_cap_bytes: 5,
                 global_cap_bytes: 4
               })
    end

    test "server_settings_changed/1 reuses the shared upload projection" do
      v = view(:litterbox, ["irc.sindro.me", "irc.sniffo.org"])
      changed = Wire.server_settings_changed(v)
      assert changed.upload == Wire.upload_view(v.upload)
    end
  end
end
