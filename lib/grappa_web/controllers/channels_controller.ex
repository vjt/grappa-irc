defmodule GrappaWeb.ChannelsController do
  @moduledoc """
  Channel-tree read surface (`index/2`) + upstream JOIN / PART
  (`create/2` + `delete/2`) for the per-(user, network) session.

  Sub-task 2g: lookup is keyed by `(conn.assigns.current_user_id,
  network.id)` end-to-end. The URL `:network_id` slug → schema struct
  resolution + per-user credential check happens in
  `GrappaWeb.Plugs.ResolveNetwork`; this controller reads
  `conn.assigns.network` and never re-resolves.

  ## index

  `GET /networks/:network_id/channels` returns the credential's
  `:autojoin_channels` (Phase 3 walking-skeleton source-of-truth).
  Per-user iso is enforced by `Plugs.ResolveNetwork` upstream — both
  "wrong slug" and "someone else's network" surface to the wire as the
  same uniform `404 {"error": "not_found"}` body so probers cannot
  distinguish. Session-tracked membership (so JOIN-via-REST mutations
  show up here too) lands in Phase 5.

  ## create / delete

  Both require an active session for the network — without one,
  `Grappa.Session.send_*` returns `{:error, :no_session}` which the
  `FallbackController` maps to a uniform 404 `{"error": "not_found"}`
  (CP10 S14 oracle close: same body as the unknown-slug and
  not-your-network cases). The internal `:no_session` tag is preserved
  in `Session` boundary @specs and operator log lines for tracing,
  but never reaches the wire. Persistence of JOIN/PART events into
  scrollback lands in Phase 5.
  """
  use GrappaWeb, :controller

  import GrappaWeb.Validation, only: [validate_channel_name: 1]

  alias Grappa.Networks.Credentials
  alias Grappa.Session

  @doc """
  `GET /networks/:network_id/channels` — lists the user's channels for
  the network. Returns the credential's `:autojoin_channels` rendered
  via `Networks.Wire.channel_to_json/1`. The slug → network resolution
  + per-user credential check live in `Plugs.ResolveNetwork`; this
  action only loads the credential's autojoin list.
  """
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :not_found}
  def index(conn, _) do
    user = conn.assigns.current_user
    network = conn.assigns.network

    with {:ok, credential} <- Credentials.get_credential(user, network) do
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
end
