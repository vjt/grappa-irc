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

  `GET /networks/:network_id/channels` returns the union of the
  credential's `:autojoin_channels` and the live session-tracked
  channel set (`Grappa.Session.list_channels/2`). Wire shape per
  channel: `%{name, joined, source}` where `:source` is `:autojoin`
  for autojoin-declared entries (winner on overlap, Q3 pin) and
  `:joined` for dynamically-joined-only entries. A5 close (P4-1):
  pre-A5 the action returned only the autojoin list, so JOIN-via-REST
  mutations were invisible to consumers.

  Per-user iso is enforced by `Plugs.ResolveNetwork` upstream — both
  "wrong slug" and "someone else's network" surface to the wire as the
  same uniform `404 {"error": "not_found"}` body so probers cannot
  distinguish.

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
  the network, with live joined-state.

  Composes the credential's `:autojoin_channels` list with the live
  `Grappa.Session.list_channels/2` snapshot:

    * Channels in BOTH sources: `joined: true, source: :autojoin`
      (Q3 of P4-1 cluster: `:autojoin` wins on overlap — operator
      intent durable).
    * Channels in autojoin only: `joined: false, source: :autojoin`
      (declared but not currently joined, or session not yet running).
    * Channels in session only: `joined: true, source: :joined`
      (dynamically joined via REST/IRC after boot).

  Result is sorted alphabetically by `name` for stable rendering.

  A5 close: pre-A5 the action returned only the autojoin list, so
  session-tracked dynamic JOINs were invisible to cicchetto's sidebar.
  """
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :not_found}
  def index(conn, _) do
    user = conn.assigns.current_user
    network = conn.assigns.network

    with {:ok, credential} <- Credentials.get_credential(user, network) do
      session_channels =
        case Session.list_channels({:user, user.id}, network.id) do
          {:ok, list} -> list
          {:error, :no_session} -> []
        end

      entries = merge_channel_sources(credential.autojoin_channels, session_channels)
      render(conn, :index, channels: entries)
    end
  end

  # Q3 pinned: when a channel is in both autojoin and session, source
  # is :autojoin. The merge:
  #   - autojoin ∩ session = {name, joined: true, source: :autojoin}
  #   - autojoin only      = {name, joined: false, source: :autojoin}
  #   - session only       = {name, joined: true, source: :joined}
  # Sorted alphabetically by name for wire-shape stability.
  @spec merge_channel_sources([String.t()], [String.t()]) ::
          [%{name: String.t(), joined: boolean(), source: :autojoin | :joined}]
  defp merge_channel_sources(autojoin, session) do
    autojoin_set = MapSet.new(autojoin)
    session_set = MapSet.new(session)

    autojoin_entries =
      Enum.map(autojoin_set, fn name ->
        %{name: name, joined: MapSet.member?(session_set, name), source: :autojoin}
      end)

    session_only_entries =
      session_set
      |> MapSet.difference(autojoin_set)
      |> Enum.map(fn name -> %{name: name, joined: true, source: :joined} end)

    Enum.sort_by(autojoin_entries ++ session_only_entries, & &1.name)
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
         :ok <- Session.send_join({:user, user_id}, network.id, name) do
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
         :ok <- Session.send_part({:user, user_id}, network.id, channel) do
      conn
      |> put_status(:accepted)
      |> json(%{ok: true})
    end
  end

  @doc """
  `POST /networks/:network_id/channels/:channel_id/topic` — body
  `{"body": "new topic"}`. Casts `TOPIC <channel> :<body>` upstream
  through the session AND persists a `:topic` scrollback row. Returns
  202 + `{"ok": true}` on success. CRLF / NUL injection in body
  collapses to `:invalid_line` (400). Missing/non-string body → 400.

  Backs the `/topic` slash command in cicchetto's compose box (P4-1).
  """
  @spec topic(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :bad_request | :no_session | :invalid_line}
  def topic(conn, %{"channel_id" => channel, "body" => body})
      when is_binary(body) and body != "" do
    user_id = conn.assigns.current_user_id
    network = conn.assigns.network

    with :ok <- validate_channel_name(channel),
         {:ok, _} <- Session.send_topic({:user, user_id}, network.id, channel, body) do
      conn
      |> put_status(:accepted)
      |> json(%{ok: true})
    end
  end

  def topic(_, _), do: {:error, :bad_request}
end
