defmodule Grappa.Networks.AdminWireTest do
  @moduledoc """
  Wire-shape projection tests for `Grappa.Networks.AdminWire`. The
  projection itself is pure. The `circuit_state:` composition lives
  at the controller (see
  `GrappaWeb.Admin.NetworksControllerTest`) per the boundary-cycle
  rationale in `AdminWire`'s moduledoc.
  """
  use ExUnit.Case, async: true

  alias Grappa.Networks.{AdminWire, Network}

  describe "network_to_admin_json/1" do
    test "projects every Network row field" do
      now = DateTime.utc_now()

      net = %Network{
        id: 42,
        slug: "azzurra",
        visitor_enabled: true,
        visitor_autoconnect: true,
        max_concurrent_visitor_sessions: 10,
        max_concurrent_user_sessions: 5,
        max_per_ip: 2,
        inserted_at: now,
        updated_at: now
      }

      assert %{
               id: 42,
               slug: "azzurra",
               visitor_enabled: true,
               visitor_autoconnect: true,
               max_concurrent_visitor_sessions: 10,
               max_concurrent_user_sessions: 5,
               max_per_ip: 2,
               inserted_at: ^now,
               updated_at: ^now
             } = AdminWire.network_to_admin_json(net)
    end

    test "nil caps round-trip as nil (operator-cleared = unlimited)" do
      now = DateTime.utc_now()
      # max_concurrent_user_sessions: nil explicit — the schema
      # default is 3, but the test exercises the operator-cleared
      # branch where the column was explicitly set to NULL.
      net = %Network{
        id: 1,
        slug: "n",
        max_concurrent_user_sessions: nil,
        inserted_at: now,
        updated_at: now
      }

      assert %{
               max_concurrent_visitor_sessions: nil,
               max_concurrent_user_sessions: nil,
               max_per_ip: nil
             } = AdminWire.network_to_admin_json(net)
    end
  end
end
