defmodule GrappaWeb.ChannelsController do
  @moduledoc """
  Channel-tree read surface (`index/2`) + upstream JOIN / PART
  (`create/2` + `delete/2`) for the per-(user, network) session.

  Sub-task 2g: lookup is keyed by `(conn.assigns.current_user_id,
  network.id)` end-to-end. The URL `:network_id` is a slug; this
  controller resolves it to the integer FK via
  `Networks.get_network_by_slug/1` so the session lookup matches the
  internal registry shape.

  ## index

  `GET /networks/:network_id/channels` returns the credential's
  `:autojoin_channels` (Phase 3 walking-skeleton source-of-truth).
  Per-user iso: a missing credential for `(current_user, network)`
  surfaces as `{:error, :not_found}` so probing users cannot
  distinguish "wrong slug" from "someone else's network."
  Session-tracked membership (so JOIN-via-REST mutations show up
  here too) lands in Phase 5.

  ## create / delete

  Both require an active session for the network — without one,
  `Grappa.Session.send_*` returns `{:error, :no_session}` which the
  `FallbackController` maps to a 404 with `error: "no_session"`.
  Unknown network slug returns `{:error, :not_found}` → 404 with
  `error: "not_found"`. Persistence of JOIN/PART events into
  scrollback lands in Phase 5.
  """
  use GrappaWeb, :controller

  alias Grappa.{Accounts, IRC.Identifier, Networks, Session}

  @doc """
  `GET /networks/:network_id/channels` — lists the user's channels for
  the network. Returns the credential's `:autojoin_channels` rendered
  via `Networks.Wire.channel_to_json/1`. The slug → network resolution
  + per-user credential check live in `Plugs.ResolveNetwork`; this
  action only loads the credential's autojoin list.
  """
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :not_found}
  def index(conn, _params) do
    user = Accounts.get_user!(conn.assigns.current_user_id)
    network = conn.assigns.network

    with {:ok, credential} <- Networks.get_credential(user, network) do
      render(conn, :index, channels: credential.autojoin_channels)
    end
  end

  @doc """
  `POST /networks/:network_id/channels` — body `{"name": "#chan"}`.
  Casts `JOIN <name>` upstream through the session. Returns 202 +
  `{"ok": true}`. Slug + per-user credential resolved by
  `Plugs.ResolveNetwork`; missing-credential / unknown-slug /
  no-session collapse to 404 `not_found` (S14 oracle close).
  """
  @spec create(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :bad_request | :no_session | :invalid_line}
  def create(conn, %{"name" => name})
      when is_binary(name) and name != "" do
    user_id = conn.assigns.current_user_id
    network = conn.assigns.network

    # Belt-and-braces against S29 C1: Session.send_join would also
    # reject CRLF via Identifier.safe_line_token?, but a malformed
    # channel name (missing #/&/+/!, embedded space, control byte) is
    # operator-input-shape wrong, not wire-injection wrong — surface
    # it as :bad_request rather than :invalid_line so client error
    # UX can branch correctly.
    with :ok <- validate_channel_name(name),
         :ok <- Session.send_join(user_id, network.id, name) do
      conn
      |> put_status(:accepted)
      |> json(%{ok: true})
    end
  end

  def create(_, _), do: {:error, :bad_request}

  @doc """
  `DELETE /networks/:network_id/channels/:channel_id` — casts
  `PART <channel_id>` upstream. Returns 202 + `{"ok": true}`.
  """
  @spec delete(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :bad_request | :no_session | :invalid_line}
  def delete(conn, %{"channel_id" => channel}) do
    user_id = conn.assigns.current_user_id
    network = conn.assigns.network

    with :ok <- validate_channel_name(channel),
         :ok <- Session.send_part(user_id, network.id, channel) do
      conn
      |> put_status(:accepted)
      |> json(%{ok: true})
    end
  end

  defp validate_channel_name(name) do
    if Identifier.valid_channel?(name), do: :ok, else: {:error, :bad_request}
  end
end
