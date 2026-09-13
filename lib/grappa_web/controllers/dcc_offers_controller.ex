defmodule GrappaWeb.DccOffersController do
  @moduledoc """
  The consent doors for an inbound DCC SEND (issue 2089) — the REST half
  of the banner a stranger's file raises.

  An offer is per-SESSION memory with a hold that runs out on its own, so
  every action here is a call into `Grappa.Session` and none of them
  touches the DB. The bytes are a different resource with a different
  lifetime and live behind `GrappaWeb.DccFilesController`; see its
  moduledoc for why they are not a mode of this one.

  Same `:authn` + `ResolveNetwork` pipeline as every other
  `/networks/:network_id/*` route, so ownership is asserted the same way.
  There is no per-offer ownership check on top of it, and none is needed:
  the held set lives inside the session `ResolveNetwork` already proved
  the caller owns, so a handle minted for somebody else is simply not in
  the map it is looked up in.

  `{:error, :not_held}` surfaces as 404 — this is the same posture
  `GrappaWeb.InvitesController` takes on `:not_invited`, and for the same
  reason: the client's banner is derived from server state, so a handle
  that names nothing is a real divergence (resolved on another device,
  or the hold elapsed) and the operator log wants to say which.
  """
  use GrappaWeb, :controller

  alias Grappa.Session
  alias GrappaWeb.Subject

  @doc """
  `GET /networks/:network_id/dcc_offers` — every offer this session is
  holding, in the same shape the live `dcc_offer` event carried.

  The COLD-START door. A banner is announced once on the user topic and
  Phoenix PubSub does not replay, so without this a reload leaves the
  operator with a file being held for them that nothing on screen
  mentions — and it lapses unanswered. Issue #482 in a second costume.

  `{:error, :no_session}` (503) rather than an empty list when the network
  is down: "holding nothing" and "nothing is holding" are different facts,
  and collapsing them lets a client render a confident empty state for a
  network that is simply not up.
  """
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :no_session | :timeout}
  def index(conn, _) do
    subject = Subject.to_session(conn.assigns.current_subject)

    with {:ok, offers} <- Session.list_dcc_offers(subject, conn.assigns.network.id) do
      json(conn, %{offers: offers})
    end
  end

  @doc """
  `POST /networks/:network_id/dcc_offers/:offer_id/accept` — the operator
  consents.

  **202, not 200.** The transfer runs detached off `Grappa.TaskSupervisor`
  and the outcome arrives as a scrollback row from `Grappa.Dcc.Report`, so
  a 200 would be claiming an arrival nobody has observed. What IS complete
  by the time this returns is the admission: the quota slot is spent, the
  offer has left the held set, and the resolution has already fanned out
  to every device.

  429 `rate_limited` when the daily accept allowance is gone, 507
  `insufficient_storage` when the spool budget is. Both are refusals the
  operator can act on — differently — which is why they are two atoms and
  not one.
  """
  @spec accept(Plug.Conn.t(), map()) ::
          Plug.Conn.t()
          | {:error, :no_session | :timeout | :not_held | :rate_limited | :insufficient_storage}
  def accept(conn, %{"offer_id" => offer_id}) do
    subject = Subject.to_session(conn.assigns.current_subject)

    with :ok <- Session.accept_dcc_offer(subject, conn.assigns.network.id, offer_id) do
      conn |> put_status(:accepted) |> json(%{ok: true})
    end
  end

  @doc """
  `DELETE /networks/:network_id/dcc_offers/:offer_id` — the operator
  refuses.

  200 and not 202: unlike the accept there is no detached work to await,
  so the state change is fully applied (and already broadcast) when this
  returns.

  **Nothing is sent to the peer**, and unlike the invite decline that is a
  choice rather than a limitation — IRC does have a `DCC REJECT`. See
  `Grappa.Session.refuse_dcc_offer/3` for the argument. The client copy
  must therefore say what the × DOES, not what it spares the sender.
  """
  @spec delete(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :no_session | :timeout | :not_held}
  def delete(conn, %{"offer_id" => offer_id}) do
    subject = Subject.to_session(conn.assigns.current_subject)

    with :ok <- Session.refuse_dcc_offer(subject, conn.assigns.network.id, offer_id) do
      json(conn, %{ok: true})
    end
  end
end
