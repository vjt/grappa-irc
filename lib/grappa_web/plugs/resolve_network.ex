defmodule GrappaWeb.Plugs.ResolveNetwork do
  @moduledoc """
  Per-user iso boundary for `/networks/:network_id/...` routes.

  Resolves the URL `:network_id` slug to the integer FK and authorises
  the authenticated user via credential lookup. Three failure modes —
  unknown slug, no credential for `(user, network)`, or no Accounts
  user at the asserted `current_user_id` — collapse to the same
  `{:error, :not_found}` (uniform body via `FallbackController`) so
  a probing user cannot distinguish "wrong slug" from "someone else's
  network." This is the CP10 review S14 oracle close.

  On success, assigns `:network` (the schema struct) to the conn so
  the action can use the integer FK without re-resolving — collapses
  the `Networks.get_network_by_slug/1` boilerplate from every
  network-scoped controller action.

  Runs after `Plugs.Authn`. Consumes `conn.assigns.current_user`
  (loaded once by `Plugs.Authn` per request — S42) so the credential
  lookup here doesn't re-fetch the user. Routes that don't carry
  `:network_id` (login, `/me`, `/networks` index) skip this pipeline.
  """
  @behaviour Plug

  import Plug.Conn

  alias Grappa.Networks
  alias GrappaWeb.FallbackController

  require Logger

  @impl Plug
  def init(opts), do: opts

  @impl Plug
  def call(conn, _) do
    user = conn.assigns.current_user
    slug = conn.path_params["network_id"]

    case resolve(user, slug) do
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

  defp resolve(user, slug) do
    with {:ok, network} <- Networks.get_network_by_slug(slug),
         {:ok, _} <- Networks.get_credential(user, network) do
      {:ok, network}
    else
      {:error, :not_found} -> {:error, :not_found}
    end
  end
end
