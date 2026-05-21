defmodule Grappa.ServerSettings.WireTest do
  use ExUnit.Case, async: true

  alias Grappa.ServerSettings.Wire

  describe "server_settings_changed/1 — wire shape" do
    test "renders embedded host as string" do
      view = %{
        upload: %{
          active_host: :embedded,
          per_file_cap_bytes: 10_485_760,
          global_cap_bytes: 10_737_418_240
        }
      }

      payload = Wire.server_settings_changed(view)

      assert payload.kind == "server_settings_changed"
      assert payload.upload.active_host == "embedded"
      assert payload.upload.per_file_cap_bytes == 10_485_760
      assert payload.upload.global_cap_bytes == 10_737_418_240
    end

    test "renders litterbox host as string" do
      view = %{
        upload: %{
          active_host: :litterbox,
          per_file_cap_bytes: 5_000_000,
          global_cap_bytes: 999_999
        }
      }

      payload = Wire.server_settings_changed(view)

      assert payload.upload.active_host == "litterbox"
      assert payload.upload.per_file_cap_bytes == 5_000_000
      assert payload.upload.global_cap_bytes == 999_999
    end

    test "payload is Jason-encodable (no atom values other than keys)" do
      view = %{
        upload: %{
          active_host: :embedded,
          per_file_cap_bytes: 1,
          global_cap_bytes: 2
        }
      }

      payload = Wire.server_settings_changed(view)
      json = Jason.encode!(payload)
      decoded = Jason.decode!(json)

      assert decoded["kind"] == "server_settings_changed"
      assert decoded["upload"]["active_host"] == "embedded"
      assert decoded["upload"]["per_file_cap_bytes"] == 1
      assert decoded["upload"]["global_cap_bytes"] == 2
    end

    test "kind field is the discriminator cic dispatches on" do
      view = %{upload: %{active_host: :embedded, per_file_cap_bytes: 1, global_cap_bytes: 2}}
      assert %{kind: "server_settings_changed"} = Wire.server_settings_changed(view)
    end
  end

  describe "upload_view/1 — shared atoms-out projection" do
    test "renders embedded with explicit field set" do
      assert %{
               active_host: "embedded",
               per_file_cap_bytes: 10_485_760,
               global_cap_bytes: 10_737_418_240
             } =
               Wire.upload_view(%{
                 active_host: :embedded,
                 per_file_cap_bytes: 10_485_760,
                 global_cap_bytes: 10_737_418_240
               })
    end

    test "renders litterbox" do
      assert %{active_host: "litterbox"} =
               Wire.upload_view(%{
                 active_host: :litterbox,
                 per_file_cap_bytes: 1,
                 global_cap_bytes: 2
               })
    end

    test "server_settings_changed/1 reuses the shared upload projection" do
      view = %{
        upload: %{active_host: :litterbox, per_file_cap_bytes: 7, global_cap_bytes: 8}
      }

      changed = Wire.server_settings_changed(view)
      assert changed.upload == Wire.upload_view(view.upload)
    end
  end
end
