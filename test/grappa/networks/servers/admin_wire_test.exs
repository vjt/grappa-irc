defmodule Grappa.Networks.Servers.AdminWireTest do
  @moduledoc """
  Admin-panel bucket 1 — wire-shape projection for `Grappa.Networks.Server`
  rows. The projection is pure: every field on the schema (sans the
  preloaded `:network` association) lands in the JSON. No password or
  internal state to leak — Servers carry no secrets — but the test pins
  the shape so a future field addition is a deliberate edit per
  CLAUDE.md "Adding a field = one explicit edit per Wire module."
  """
  use ExUnit.Case, async: true

  alias Grappa.Networks.Server
  alias Grappa.Networks.Servers.AdminWire

  describe "server_to_admin_json/1" do
    test "projects every Server row field" do
      now = DateTime.utc_now()

      server = %Server{
        id: 17,
        network_id: 3,
        host: "irc.example.test",
        port: 6697,
        tls: true,
        priority: 0,
        enabled: true,
        inserted_at: now,
        updated_at: now
      }

      assert %{
               id: 17,
               network_id: 3,
               host: "irc.example.test",
               port: 6697,
               tls: true,
               priority: 0,
               enabled: true,
               inserted_at: ^now,
               updated_at: ^now
             } = AdminWire.server_to_admin_json(server)
    end

    test "tls false + disabled + custom priority round-trip as is" do
      now = DateTime.utc_now()

      server = %Server{
        id: 99,
        network_id: 1,
        host: "plain.example.test",
        port: 6667,
        tls: false,
        priority: 10,
        enabled: false,
        inserted_at: now,
        updated_at: now
      }

      json = AdminWire.server_to_admin_json(server)
      assert json.tls == false
      assert json.enabled == false
      assert json.priority == 10
    end

    test "preloaded :network association is NOT exposed (no field leakage)" do
      now = DateTime.utc_now()

      server = %Server{
        id: 1,
        network_id: 1,
        network: %Grappa.Networks.Network{slug: "should-not-leak"},
        host: "h",
        port: 1,
        tls: true,
        priority: 0,
        enabled: true,
        inserted_at: now,
        updated_at: now
      }

      json = AdminWire.server_to_admin_json(server)
      refute Map.has_key?(json, :network)
    end
  end
end
