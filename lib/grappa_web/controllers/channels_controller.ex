defmodule GrappaWeb.ChannelsController do
  @moduledoc """
  Channel-tree read surface (`index/2`) + upstream JOIN / PART / TOPIC
  (`create/2` + `delete/2` + `topic/2`) for the per-(subject, network)
  session.

  Subject-dispatched (Task 30): every action reads `:current_subject`
  from `conn.assigns` (plumbed by `Plugs.Authn`) — a tagged tuple
  `{:user, %User{}} | {:visitor, %Visitor{}}` carrying the loaded
  struct (M-web-1). The `Grappa.Session.send_*` API speaks the leaner
  ID-tuple shape (`{:user, id} | {:visitor, id}`); the conversion
  goes through `GrappaWeb.Subject.to_session/1`. The URL `:network_id`
  slug → schema struct resolution + per-subject iso check happens in
  `GrappaWeb.Plugs.ResolveNetwork`; this controller reads
  `conn.assigns.network` and never re-resolves.

  ## index

  `GET /networks/:network_id/channels` returns the union of the
  subject's autojoin source (user → `Credential.autojoin_channels`,
  visitor → `Visitors.list_autojoin_channels/1`) and the live
  session-tracked channel set (`Grappa.Session.list_channels/2`).
  Wire shape per channel: `%{name, joined, source}` where `:source`
  is `:autojoin` for autojoin-declared entries (winner on overlap,
  Q3 pin) and `:joined` for dynamically-joined-only entries.

  Per-subject iso is enforced by `Plugs.ResolveNetwork` upstream —
  visitor's `network_slug` mismatch and user's missing-credential
  both surface as the same uniform `404 {"error": "not_found"}` body
  so probers cannot distinguish.

  ## create / delete / topic

  All require an active session for the network — without one,
  `Grappa.Session.send_*` returns `{:error, :no_session}` which the
  `FallbackController` maps to a uniform 404 `{"error": "not_found"}`
  (CP10 S14 oracle close). Persistence of JOIN/PART events into
  scrollback lands in Phase 5.
  """
  use GrappaWeb, :controller

  import GrappaWeb.Validation, only: [validate_channel_name: 1]

  alias Grappa.Networks.Credentials
  alias Grappa.{Session, Visitors}
  alias GrappaWeb.Subject

  @doc """
  `GET /networks/:network_id/channels` — lists the subject's channels
  for the network, with live joined-state.

  Composes the subject's autojoin source with the live
  `Grappa.Session.list_channels/2` snapshot (Q3-pinned: autojoin wins
  on overlap). Result is sorted alphabetically by `name` for stable
  rendering.
  """
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :not_found}
  def index(conn, _) do
    network = conn.assigns.network
    subject = conn.assigns.current_subject

    with {:ok, autojoin} <- subject_autojoin(subject, network) do
      session_channels =
        case Session.list_channels(Subject.to_session(subject), network.id) do
          {:ok, list} -> list
          {:error, :no_session} -> []
        end

      entries = merge_channel_sources(autojoin, session_channels)
      render(conn, :index, channels: entries)
    end
  end

  defp subject_autojoin({:user, user}, network) do
    with {:ok, credential} <- Credentials.get_credential(user, network) do
      {:ok, credential.autojoin_channels}
    end
  end

  defp subject_autojoin({:visitor, visitor}, _) do
    {:ok, Visitors.list_autojoin_channels(visitor)}
  end

  # Q3 pinned: when a channel is in both autojoin and session, source
  # is :autojoin. Sorted alphabetically by name for wire-shape stability.
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
  Casts `JOIN <name>` upstream through the subject's session. Returns
  202 + `{"ok": true}`.
  """
  @spec create(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :bad_request | :no_session | :invalid_line}
  def create(conn, %{"name" => name})
      when is_binary(name) and name != "" do
    subject = Subject.to_session(conn.assigns.current_subject)
    network = conn.assigns.network

    with :ok <- validate_channel_name(name),
         :ok <- Session.send_join(subject, network.id, name) do
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
    subject = Subject.to_session(conn.assigns.current_subject)
    network = conn.assigns.network

    with :ok <- validate_channel_name(channel),
         :ok <- Session.send_part(subject, network.id, channel) do
      conn
      |> put_status(:accepted)
      |> json(%{ok: true})
    end
  end

  @doc """
  `POST /networks/:network_id/channels/:channel_id/topic` — body
  `{"body": "new topic"}`. Casts `TOPIC <channel> :<body>` upstream
  through the subject's session AND persists a `:topic` scrollback
  row.
  """
  @spec topic(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :bad_request | :no_session | :invalid_line}
  def topic(conn, %{"channel_id" => channel, "body" => body})
      when is_binary(body) and body != "" do
    subject = Subject.to_session(conn.assigns.current_subject)
    network = conn.assigns.network

    with :ok <- validate_channel_name(channel),
         {:ok, _} <- Session.send_topic(subject, network.id, channel, body) do
      conn
      |> put_status(:accepted)
      |> json(%{ok: true})
    end
  end

  def topic(_, _), do: {:error, :bad_request}
end
