defmodule GrappaWeb.NickController do
  @moduledoc """
  `POST /networks/:network_id/nick` — change the operator's nick on
  the upstream IRC connection.

  ## Subject branching (Task 30)

  Visitor sessions are forbidden from changing nick (Q2(a) pin):

    * The visitor row's `(nick, network_slug)` carries a unique-index
      W2 invariant — letting the visitor rename would require either
      DB-persisting the change (which collides with concurrent anon
      logins under the same nick) or letting upstream NICK drift
      from the row (creating two-nicks-per-visitor canonical
      ambiguity).
    * Mode-3 NickServ-IDP visitors anchor identity to the registered
      nick — renaming would unbind the IDP linkage.
    * Anon Mode-2 visitors can re-login with a different identifier
      (anon TTL is 48h short-lived) so the escape valve exists
      without the controller having to support it.

  Forbidding for ALL visitor subjects keeps the wire shape uniform
  and forward-compatible per the CLAUDE.md MARKREAD principle:
  adding the capability later is fine; removing it would break
  clients that depended on it.

  Iso boundary: `Plugs.ResolveNetwork` collapses unknown-slug /
  not-your-network to 404 BEFORE this action runs. The `:no_session`
  tag from `Session.send_nick/3` collapses to the same 404 wire body
  via `FallbackController` (S14 oracle close).

  Cluster: P4-1 — backs the `/nick <new>` slash command in cicchetto's
  ComposeBox.
  """
  use GrappaWeb, :controller

  alias Grappa.Accounts.User
  alias Grappa.Session

  @doc """
  `POST /networks/:network_id/nick` — body `{"nick": "newname"}`. For
  user subjects sends `NICK <new>` upstream through the session and
  returns 202 + `{"ok": true}`. Empty / non-string nick → 400.
  `:no_session` / `:invalid_line` collapse through `FallbackController`
  to 404 / 400 respectively. For visitor subjects returns 403
  `{"error": "forbidden"}` (Task 30 / Q2(a)).
  """
  @spec create(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :bad_request | :forbidden | :no_session | :invalid_line}
  def create(conn, %{"nick" => nick}) when is_binary(nick) and nick != "" do
    case conn.assigns.current_subject do
      {:user, %User{id: user_id}} ->
        network = conn.assigns.network

        with :ok <- Session.send_nick({:user, user_id}, network.id, nick) do
          conn
          |> put_status(:accepted)
          |> json(%{ok: true})
        end

      {:visitor, _} ->
        {:error, :forbidden}
    end
  end

  def create(_, _), do: {:error, :bad_request}
end
