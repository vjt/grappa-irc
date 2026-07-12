defmodule Grappa.Visitors.AutoconnectTest do
  @moduledoc """
  #211 phase 6 (ruling C) — `Visitors.autoconnect/3`: the zero-friction
  multi-network fan-out fired ASYNC after a successful login. Attaches +
  spawns each `visitor_autoconnect` network the identity isn't already on
  (minus the sync anchor); a PARKED network stays parked (ruling D
  persistence — autoconnect never un-parks a deliberate disconnect).

  `async: false` — spawns Session.Server under the singleton supervisor.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.AdmissionStateHelpers
  alias Grappa.{IRCServer, Networks, Repo, Session, Visitors}
  alias Grappa.Networks.Credentials

  setup do
    AdmissionStateHelpers.reset_network_circuit()
    :ok
  end

  defp start_server do
    {:ok, server} = IRCServer.start_link(fn state, _ -> {:reply, nil, state} end)
    {server, IRCServer.port(server)}
  end

  # A visitor identity already live on `anchor` (an autoconnect network),
  # mirroring the post-login anchor state. Returns {visitor, anchor}.
  defp visitor_on_anchor do
    {server, port} = start_server()
    {visitor, anchor} = visitor_with_network(port)
    {:ok, _} = Networks.update_network_settings(anchor, %{visitor_enabled: true, visitor_autoconnect: true})
    _ = start_visitor_session_for(visitor, anchor)
    {:ok, _} = IRCServer.wait_for_line(server, &String.starts_with?(&1, "USER"), 5_000)
    {visitor, anchor}
  end

  test "spawns each visitor_autoconnect network minus the anchor" do
    {visitor, anchor} = visitor_on_anchor()

    {server_b, port_b} = start_server()

    {:ok, net_b} =
      Networks.create_network(%{slug: "b-auto", visitor_enabled: true, visitor_autoconnect: true})

    {:ok, _} = Networks.Servers.add_server(net_b, %{host: "127.0.0.1", port: port_b, tls: false})

    on_exit(fn -> Session.stop_session({:visitor, visitor.id}, net_b.id) end)

    :ok = Visitors.autoconnect(visitor, anchor.id, "1.2.3.4")

    {:ok, _} = IRCServer.wait_for_line(server_b, &String.starts_with?(&1, "NICK"), 5_000)
    # B is live; the anchor is untouched (still live).
    assert is_pid(Session.whereis({:visitor, visitor.id}, net_b.id))
    assert is_pid(Session.whereis({:visitor, visitor.id}, anchor.id))
  end

  test "a PARKED autoconnect network stays parked (not respawned)" do
    {visitor, anchor} = visitor_on_anchor()

    {_, port_b} = start_server()

    {:ok, net_b} =
      Networks.create_network(%{slug: "b-parked", visitor_enabled: true, visitor_autoconnect: true})

    {:ok, _} = Networks.Servers.add_server(net_b, %{host: "127.0.0.1", port: port_b, tls: false})

    # The visitor previously attached + PARKED network B (a deliberate
    # per-network disconnect).
    {:ok, cred_b} =
      Credentials.upsert_visitor_credential(visitor.id, net_b.id, %{
        nick: visitor.nick,
        auth_method: :none
      })

    {:ok, _} =
      cred_b
      |> Ecto.Changeset.change(connection_state: :parked, connection_state_reason: "disconnect")
      |> Repo.update()

    :ok = Visitors.autoconnect(visitor, anchor.id, "1.2.3.4")

    # B stays parked — autoconnect's :already_attached skip leaves it be.
    assert is_nil(Session.whereis({:visitor, visitor.id}, net_b.id))
    {:ok, reload} = Credentials.get_visitor_credential(visitor.id, net_b.id)
    assert reload.connection_state == :parked
  end

  test "no-op when the anchor is the only autoconnect network" do
    {visitor, anchor} = visitor_on_anchor()

    # Only the anchor is flagged autoconnect → nothing else to fan out.
    :ok = Visitors.autoconnect(visitor, anchor.id, "1.2.3.4")

    # Still exactly the anchor session; no others spawned.
    assert is_pid(Session.whereis({:visitor, visitor.id}, anchor.id))
  end
end
