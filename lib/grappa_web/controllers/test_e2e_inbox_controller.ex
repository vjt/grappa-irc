if Mix.env() in [:dev, :test] do
  defmodule GrappaWeb.TestE2eInboxController do
    @moduledoc """
    Test-only door that makes the caller's offline queue of encrypted
    messages expire now (issue 2430), so an e2e spec can see the
    recipient-only "undeliverable" notice without waiting out a seven-day
    TTL. All the work is `Grappa.TestSupport.E2eInboxExpiry.expire_now/2`,
    which runs the production sweep.

    `POST /networks/:network_id/e2e/inbox/expire` → 204, or 404 when no
    session runs for the network. The caller's OWN bearer, same
    `[:api, :authn, :resolve_network]` pipeline as the production queue
    routes. Compile-gated to `:dev`/`:test`, like
    `GrappaWeb.TestReadCursorController`: the module and its route do not
    exist in the prod release.
    """
    use GrappaWeb, :controller

    alias Grappa.TestSupport.E2eInboxExpiry
    alias GrappaWeb.Subject

    @spec expire(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :no_session}
    def expire(conn, _) do
      with :ok <- E2eInboxExpiry.expire_now(Subject.to_session(conn.assigns.current_subject), conn.assigns.network.id) do
        send_resp(conn, :no_content, "")
      end
    end
  end
end
