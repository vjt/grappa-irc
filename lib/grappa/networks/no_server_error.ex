defmodule Grappa.Networks.NoServerError do
  @moduledoc """
  Raised by `Grappa.Networks.Servers.pick_server!/1` when a network
  resolves to zero enabled server endpoints.

  Lives in the `Networks` boundary because the policy is operator-side
  ("which endpoint of this network do we connect to?") and `Networks`
  owns the server list. Pre-A2/A10 this exception lived inside
  `Grappa.Session.Server` — the cycle inversion lifts it where the
  domain belongs so the Session boundary stays a pure consumer of
  pre-resolved connect data.

  Operator must add at least one enabled server via
  `mix grappa.add_server` before the session can boot.
  """
  defexception [:network_id, :network_slug]

  @impl Exception
  def message(%{network_id: id, network_slug: slug}) do
    "network ##{id} (#{slug}) has no enabled server endpoints"
  end
end
