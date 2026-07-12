defmodule GrappaWeb.Plugs.ResolveNetwork do
  @moduledoc """
  Per-subject iso boundary for `/networks/:network_id/...` routes.

  Resolves the URL `:network_id` slug to the schema struct and
  authorises the authenticated subject. Branches on
  `conn.assigns.current_subject` (set by `Plugs.Authn`) — the tagged
  tuple carries the loaded subject struct directly (M-web-1):

    * **User** — credential lookup against the loaded `%User{}`.
      Failure modes (unknown slug → `:not_found`; slug exists but no
      credential for `(user, network)` → `:no_credential`; missing user
      row → `:not_found`) all collapse to a uniform `404` on the wire so
      a probing user cannot distinguish "wrong slug" from "someone else's
      network." This is the CP10 review S14 oracle close. The
      `:no_credential` discriminator is preserved in the operator log
      (W7) so credential-drift incidents stay greppable, symmetric with
      the visitor-branch's `:wrong_network`.
    * **Visitor** — credential lookup against the loaded `%Visitor{}`,
      mirroring the user branch (#211 phase 6). A visitor is
      multi-network now (accretion), so the pre-phase-6 slug-equality
      check against the singular `visitor.network_slug` — which 404'd
      EVERY accreted network B on the wire — is retired. Failure modes
      (unknown slug → `:not_found`; slug exists but no visitor credential
      for `(visitor, network)` → `:no_credential`) collapse to the same
      uniform 404 — same no-leak posture as the user branch.

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
        #
        # W7: the internal discriminator (`:no_credential` for "network
        # exists but not bound to this subject") is logged so operators
        # can distinguish credential drift from probing. Wire stays
        # uniform 404 — no oracle leak (CP10 S14 design intent). Both
        # subjects share the `:no_credential` discriminator since #211
        # phase 6 (the visitor branch's `:wrong_network` is retired).
        Logger.info("network resolve rejected", reason: reason)

        conn
        |> FallbackController.call({:error, :not_found})
        |> halt()
    end
  end

  @typep resolve_error ::
           :not_found | :no_credential

  @spec resolve(GrappaWeb.Subject.t(), String.t()) ::
          {:ok, Grappa.Networks.Network.t()} | {:error, resolve_error()}
  defp resolve({:user, %User{} = user}, slug) do
    case Networks.get_network_by_slug(slug) do
      {:ok, network} ->
        case Credentials.get_credential(user, network) do
          {:ok, _} -> {:ok, network}
          {:error, :not_found} -> {:error, :no_credential}
        end

      {:error, :not_found} ->
        {:error, :not_found}
    end
  end

  defp resolve({:visitor, %Visitor{id: id}}, slug) do
    case Networks.get_network_by_slug(slug) do
      {:ok, network} ->
        # #211 phase 6 — subject-scoped credential presence check, the
        # mirror of the user branch. `get_visitor_credential/2` is
        # `WHERE visitor_id ==` (subject-blind-safe): a visitor can never
        # resolve onto another subject's network. An accreted network B
        # (phase 4c) now opens over REST — pre-phase-6 the singular
        # `network_slug` slug-equality 404'd it here.
        case Credentials.get_visitor_credential(id, network.id) do
          {:ok, _} -> {:ok, network}
          {:error, :not_found} -> {:error, :no_credential}
        end

      {:error, :not_found} ->
        {:error, :not_found}
    end
  end
end
