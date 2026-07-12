defmodule Grappa.Visitors.AdminWireTest do
  @moduledoc """
  Wire-shape contract for the operator-facing `GET /admin/visitors`
  endpoint (M-cluster M-4). Distinct from `Grappa.Visitors.Wire` which
  serves cic/auth-facing surfaces. Admin shape carries operator-only
  fields (ip, inserted_at) + the per-network `live_state` join from
  `Grappa.LiveIntrospection`.

  ## #211 phase 7 — multi-network shape

  A visitor is multi-network; per-network identity (nick) + connection
  state live on the credential. So `visitor_to_admin_json/2` takes a
  `[{%Credential{}, live_state | nil}]` list and renders a `:networks`
  list — one entry per credential.

  ## Defensive assertion (CRITICAL)

  Every test asserts `:password_encrypted` is NEVER in the rendered
  map. Same protection rationale as `Grappa.Visitors.Wire`'s moduledoc
  documents — the Cloak field decrypts on read; raw JSON serialization
  would leak the upstream NickServ password. If you're tempted to add
  the field to the admin shape, stop and re-read Wire's moduledoc.
  """
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.LiveIntrospection.SessionEntry
  alias Grappa.Networks.Credentials
  alias Grappa.Visitors
  alias Grappa.Visitors.{AdminWire, Visitor}

  describe "visitor_to_admin_json/2" do
    test "includes operator-visible fields + per-network live_state and never password_encrypted" do
      network = network_fixture(slug: "azzurra-#{System.unique_integer([:positive])}")

      {:ok, %Visitor{} = v} =
        Visitors.find_or_provision_anon("alpha", network.slug, "10.0.0.5")

      [cred] = Credentials.list_visitor_credentials(v.id)

      live = %SessionEntry{
        subject: {:visitor, v.id},
        network_id: network.id,
        pid: self(),
        alive: true,
        mailbox_len: 0,
        memory_bytes: 12_345,
        joined_channels: ["#sbiffo"],
        introspection_degraded: []
      }

      json = AdminWire.visitor_to_admin_json(v, [{cred, live}])

      assert json.id == v.id
      assert json.ip == "10.0.0.5"
      assert %DateTime{} = json.expires_at
      assert json.identified == false
      assert %DateTime{} = json.inserted_at

      assert [net] = json.networks
      assert net.nick == "alpha"
      assert net.network_slug == network.slug
      assert net.connection_state == cred.connection_state
      assert is_map(net.live_state)
      assert net.live_state.alive == true
      assert net.live_state.memory_bytes == 12_345
      assert net.live_state.mailbox_len == 0
      assert net.live_state.joined_channels == ["#sbiffo"]
      assert net.live_state.introspection_degraded == []
      assert is_binary(net.live_state.pid_inspect)

      refute Map.has_key?(net, :password_encrypted)
      refute Map.has_key?(json, :password_encrypted)
    end

    test "with nil live_state returns per-network live_state: nil (U-0 honesty signal)" do
      network = network_fixture(slug: "azzurra-#{System.unique_integer([:positive])}")
      {:ok, v} = Visitors.find_or_provision_anon("solo", network.slug, "10.0.0.5")
      [cred] = Credentials.list_visitor_credentials(v.id)

      json = AdminWire.visitor_to_admin_json(v, [{cred, nil}])

      assert [net] = json.networks
      assert net.live_state == nil
      refute Map.has_key?(json, :password_encrypted)
    end

    test "a credential-less visitor yields networks: []" do
      # A bare visitor row whose slug does not resolve → no credential.
      v = visitor_fixture(nick: "bare", network_slug: "no-such-network")

      json = AdminWire.visitor_to_admin_json(v, [])

      assert json.networks == []
    end

    test "identified visitor (holds a NickServ credential) → identified: true" do
      network = network_fixture(slug: "azzurra-#{System.unique_integer([:positive])}")
      {:ok, v} = Visitors.find_or_provision_anon("nsv", network.slug, "10.0.0.5")
      {:ok, _} = Visitors.commit_password(v.id, network.id, "s3cret")
      identified = Visitors.get!(v.id)
      # #211 phase 7 — `identified` DERIVES from the per_network creds (any
      # holds a committed secret), so the credential list must be passed in.
      [cred] = Credentials.list_visitor_credentials(v.id)

      json = AdminWire.visitor_to_admin_json(identified, [{cred, nil}])

      assert json.identified == true
      refute Map.has_key?(json, :password_encrypted)
    end
  end
end
