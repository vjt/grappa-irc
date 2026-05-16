defmodule Grappa.Visitors.AdminWireTest do
  @moduledoc """
  Wire-shape contract for the operator-facing `GET /admin/visitors`
  endpoint (M-cluster M-4). Distinct from `Grappa.Visitors.Wire` which
  serves cic/auth-facing surfaces. Admin shape carries operator-only
  fields (ip, inserted_at) + the `live_state` join from
  `Grappa.LiveIntrospection`.

  ## Defensive assertion (CRITICAL)

  Every test asserts `:password_encrypted` is NEVER in the rendered
  map. Same protection rationale as `Grappa.Visitors.Wire`'s moduledoc
  documents — the Cloak field decrypts on read; raw JSON serialization
  would leak the upstream NickServ password. If you're tempted to add
  the field to the admin shape, stop and re-read Wire's moduledoc.
  """
  use Grappa.DataCase, async: true

  alias Grappa.LiveIntrospection.SessionEntry
  alias Grappa.Visitors
  alias Grappa.Visitors.{AdminWire, Visitor}

  describe "visitor_to_admin_json/2" do
    test "includes operator-visible fields + live_state and never password_encrypted" do
      {:ok, %Visitor{} = v} =
        Visitors.find_or_provision_anon("alpha", "azzurra", "10.0.0.5")

      live = %SessionEntry{
        subject: {:visitor, v.id},
        network_id: 42,
        pid: self(),
        alive: true,
        mailbox_len: 0,
        memory_bytes: 12_345,
        joined_channels: ["#sbiffo"],
        introspection_degraded: []
      }

      json = AdminWire.visitor_to_admin_json(v, live)

      assert json.id == v.id
      assert json.nick == "alpha"
      assert json.network_slug == "azzurra"
      assert json.ip == "10.0.0.5"
      assert %DateTime{} = json.expires_at
      assert json.identified == false
      assert %DateTime{} = json.inserted_at
      assert is_map(json.live_state)
      assert json.live_state.alive == true
      assert json.live_state.memory_bytes == 12_345
      assert json.live_state.mailbox_len == 0
      assert json.live_state.joined_channels == ["#sbiffo"]
      assert json.live_state.introspection_degraded == []
      assert is_binary(json.live_state.pid_inspect)

      refute Map.has_key?(json, :password_encrypted)
    end

    test "with nil live_state returns live_state: nil (U-0 honesty signal)" do
      {:ok, v} = Visitors.find_or_provision_anon("solo", "azzurra", "10.0.0.5")

      json = AdminWire.visitor_to_admin_json(v, nil)

      assert json.live_state == nil
      refute Map.has_key?(json, :password_encrypted)
    end

    test "identified visitor (expires_at = nil) → identified: true" do
      {:ok, v} = Visitors.find_or_provision_anon("nsv", "azzurra", "10.0.0.5")
      {:ok, identified} = Visitors.commit_password(v.id, "s3cret")

      json = AdminWire.visitor_to_admin_json(identified, nil)

      assert json.identified == true
      assert json.expires_at == nil
      refute Map.has_key?(json, :password_encrypted)
    end
  end
end
