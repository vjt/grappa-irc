defmodule GrappaWeb.Plugs.ResolveNetwork do
  @moduledoc """
  Per-subject iso boundary for `/networks/:network_id/...` routes.

  Resolves the URL `:network_id` slug to the schema struct and
  authorises the authenticated subject. Branches on
  `conn.assigns.current_subject` (set by `Plugs.Authn`) — the tagged
  tuple carries the loaded subject struct directly (M-web-1):

    * **User** — credential lookup against the loaded `%User{}`.
      Failure modes (unknown slug, no credential for `(user, network)`,
      missing user row) collapse to the same `{:error, :not_found}` so
      a probing user cannot distinguish "wrong slug" from "someone
      else's network." This is the CP10 review S14 oracle close.
    * **Visitor** — slug-equality check against the loaded
      `%Visitor{}`'s `network_slug` (visitors are bound to one network
      at row-creation; W11). A mismatched slug collapses to the same
      uniform 404 — same no-leak posture as the user-side credential
      miss.

  On success, assigns `:network` (the schema struct) to the conn so
  the action can use the integer FK without re-resolving.

  Runs after `Plugs.Authn`. Routes that don't carry `:network_id`
  (login, `/me`, `/networks` index) skip this pipeline.
  """
  @behaviour Plug

  import Plug.Conn

  alias Grappa.Accounts.User
  alias Grappa.Networks
  alias Grappa.Networks.Credentials
  alias Grappa.Visitors.Visitor
  alias GrappaWeb.FallbackController

  require Logger

  @impl Plug
  def init(opts), do: opts

  @impl Plug
  def call(conn, _) do
    slug = conn.path_params["network_id"]

    case resolve(conn.assigns.current_subject, slug) do
      {:ok, network} ->
        assign(conn, :network, network)

      {:error, reason} ->
        # Reason stays in operator logs (greppable) but never reaches
        # the wire — the 404 body is uniform on purpose so the plug
        # doesn't leak network-existence to a probing attacker.
        # Mirrors `Plugs.Authn`'s `authn_failure` posture for the
        # network-iso boundary.
        Logger.info("network resolve rejected", reason: reason)

        conn
        |> FallbackController.call({:error, :not_found})
        |> halt()
    end
  end

  defp resolve({:user, %User{} = user}, slug) do
    with {:ok, network} <- Networks.get_network_by_slug(slug),
         {:ok, _} <- Credentials.get_credential(user, network) do
      {:ok, network}
    else
      {:error, :not_found} -> {:error, :not_found}
    end
  end

  defp resolve({:visitor, %Visitor{network_slug: vslug}}, slug) do
    case Networks.get_network_by_slug(slug) do
      {:ok, network} when network.slug == vslug -> {:ok, network}
      {:ok, _} -> {:error, :wrong_network}
      {:error, :not_found} -> {:error, :not_found}
    end
  end
end
