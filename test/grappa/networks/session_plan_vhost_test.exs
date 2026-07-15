defmodule Grappa.Networks.SessionPlanVhostTest do
  @moduledoc """
  #228 — `Grappa.Networks.SessionPlan.base_plan/7` resolves the plan's
  `source_address` through `Grappa.Vhosts.effective_source/2` (the
  per-subject vhost layer) instead of copying `server.source_address`
  verbatim. The per-server fixed source becomes the FALLBACK, not the
  value — a self-selection overrides it (#251 — the admin pin was removed).
  """
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Networks.{Credential, Server, SessionPlan}
  alias Grappa.Vhosts

  test "with no pin / no selection, source_address falls back to server.source_address" do
    user = user_fixture()
    network = network_fixture()
    cred = %Credential{nick: "n", auth_method: :none, autojoin_channels: [], last_joined_channels: []}
    server = %Server{host: "irc.example.test", port: 6697, tls: true, source_address: "2001:db8::99"}

    plan = SessionPlan.base_plan({:user, user.id}, "label", cred, network, server, "n")
    assert plan.source_address == "2001:db8::99"
  end

  test "with a nil server source and no vhost config, source_address is nil" do
    user = user_fixture()
    network = network_fixture()
    cred = %Credential{nick: "n", auth_method: :none, autojoin_channels: [], last_joined_channels: []}
    server = %Server{host: "irc.example.test", port: 6697, tls: true, source_address: nil}

    plan = SessionPlan.base_plan({:user, user.id}, "label", cred, network, server, "n")
    assert plan.source_address == nil
  end

  test "a self-selected generally-available vhost overrides the server source" do
    user = user_fixture()
    network = network_fixture()
    {:ok, vhost} = Vhosts.create_vhost(%{address: "2001:db8::def", generally_available: true})
    {:ok, _} = Vhosts.set_selection({:user, user.id}, [vhost.address])

    cred = %Credential{nick: "n", auth_method: :none, autojoin_channels: [], last_joined_channels: []}
    server = %Server{host: "irc.example.test", port: 6697, tls: true, source_address: "2001:db8::99"}

    plan = SessionPlan.base_plan({:user, user.id}, "label", cred, network, server, "n")
    assert plan.source_address == "2001:db8::def"
  end
end
