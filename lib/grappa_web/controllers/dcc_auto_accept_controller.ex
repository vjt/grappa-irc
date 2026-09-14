defmodule GrappaWeb.DccAutoAcceptController do
  @moduledoc """
  REST surface for the per-network DCC auto-accept opt-in (issue 2143) —
  `/networks/:network_id/dcc-auto-accept`.

  Thin per CLAUDE.md: parse params, call `Grappa.UserSettings`, render.

  ## Why there is no live-session sync

  The sibling `/ignores` door pushes every mutation into the running
  session because `state.ignores` is a CACHE that would otherwise go
  stale. This one pushes nothing, deliberately: `Grappa.Session.Server`
  reads the opt-in from `Grappa.UserSettings` at the moment an offer
  arrives, so there is no second copy to keep in step. Offers arrive at
  human pace — one per decision on the far side — which is nowhere near
  a hot path, and a cache here would be the duplicated state CLAUDE.md's
  design discipline warns about, bought for nothing.

  ## The flag is HALF a gate, and this door cannot see the other half

  Turning it on does not mean files get accepted. `Session.Server` also
  requires an open query window with the offering peer — the restriction
  that keeps #546 intact. A client rendering this switch should say so;
  `enabled: true` means "auto-accept from people I already talk to here",
  never "auto-accept".

  Iso boundary: `Plugs.ResolveNetwork` collapses unknown-slug /
  not-your-network to 404 before any action runs, same as `/ignores` and
  `/notify`.
  """
  use GrappaWeb, :controller

  alias Grappa.UserSettings
  alias GrappaWeb.Subject, as: WebSubject

  @doc "`GET /networks/:network_id/dcc-auto-accept` — the opt-in for this subject here."
  @spec show(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def show(conn, _) do
    network = conn.assigns.network
    enabled = UserSettings.get_dcc_auto_accept(session_subject(conn), network.slug)
    json(conn, %{enabled: enabled})
  end

  @doc """
  `PUT /networks/:network_id/dcc-auto-accept` — set the opt-in. Body
  `{"enabled": true | false}`. 200 with the stored value.

  The guard takes a LITERAL boolean and nothing else. `"true"`, `1` and
  `null` are 400 rather than coerced: this is a consent switch, and a
  coerced truthy value would arm a gate the operator never armed.
  """
  @spec update(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :bad_request | term()}
  def update(conn, %{"enabled" => enabled}) when is_boolean(enabled) do
    subject = session_subject(conn)
    network = conn.assigns.network

    with {:ok, _settings} <- UserSettings.put_dcc_auto_accept(subject, network.slug, enabled) do
      json(conn, %{enabled: enabled})
    end
  end

  def update(_, _), do: {:error, :bad_request}

  defp session_subject(conn), do: WebSubject.to_session(conn.assigns.current_subject)
end
