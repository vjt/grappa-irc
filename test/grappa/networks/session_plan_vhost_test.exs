defmodule Grappa.Networks.SessionPlanVhostTest do
  @moduledoc """
  #228 / #266 — `Grappa.Networks.SessionPlan.base_plan/7` resolves the
  plan's `source_address` through `Grappa.Vhosts.effective_source/2` (the
  per-subject vhost layer). #266 INVERTS the #251 precedence: an admin-set
  per-network `server.source_address` now WINS over a subject's vhost
  self-selection (Libera go-live: an admin-pinned, accountable egress).
  The per-server source is the value when set; the vhost selection is the
  fallback ONLY when no source is pinned.
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

  test "an admin server source WINS over a self-selected vhost (#266)" do
    user = user_fixture()
    network = network_fixture()
    {:ok, vhost} = Vhosts.create_vhost(%{address: "2001:db8::def", generally_available: true})
    {:ok, _} = Vhosts.set_selection({:user, user.id}, [vhost.address])

    cred = %Credential{nick: "n", auth_method: :none, autojoin_channels: [], last_joined_channels: []}
    server = %Server{host: "irc.example.test", port: 6697, tls: true, source_address: "2001:db8::99"}

    plan = SessionPlan.base_plan({:user, user.id}, "label", cred, network, server, "n")
    assert plan.source_address == "2001:db8::99"
  end

  test "with a nil server source, a self-selected vhost is used (#266 fallback)" do
    user = user_fixture()
    network = network_fixture()
    {:ok, vhost} = Vhosts.create_vhost(%{address: "2001:db8::def", generally_available: true})
    {:ok, _} = Vhosts.set_selection({:user, user.id}, [vhost.address])

    cred = %Credential{nick: "n", auth_method: :none, autojoin_channels: [], last_joined_channels: []}
    server = %Server{host: "irc.example.test", port: 6697, tls: true, source_address: nil}

    plan = SessionPlan.base_plan({:user, user.id}, "label", cred, network, server, "n")
    assert plan.source_address == "2001:db8::def"
  end
end
