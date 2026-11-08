defmodule GrappaWeb.CommonChannelsController do
  @moduledoc """
  Channels in common with a peer, from the caller's own live member
  lists (issue 2449). Source-of-truth is
  `Grappa.Session.common_channels/3` — the `Session.Server.state.members`
  map, populated by `Grappa.Session.EventRouter` from upstream
  JOIN/353/PART/QUIT/etc. No NAMES/WHO round trip.

  Snapshot endpoint, not subscription. Cicchetto fetches it when a
  query window opens (and on focus, to close the presence-pause /
  cold-start gaps a purely local derivation would leave); presence
  updates flow through the existing `MessagesChannel` PubSub events.

  Iso boundary: `Plugs.ResolveNetwork` collapses unknown-slug /
  not-your-network to 404 BEFORE this action runs. The
  `:no_session` tag from `Session.common_channels/3` collapses to the
  same 404 wire body via `FallbackController` (CP10 S14 oracle close).
  """
  use GrappaWeb, :controller

  alias Grappa.Session
  alias GrappaWeb.Subject

  @doc """
  `GET /networks/:network_id/common-channels?nick=<nick>` — returns
  the sorted channels the caller shares with `nick`, as
  `{"channels": ["#a", "#b"]}`. Wraps
  `Grappa.Session.common_channels/3`. Snapshot, not subscription.

  Any nick is queryable: the answer is the caller's OWN observed
  membership, not a lookup of the peer. A peer that shares no SEEDED
  channel — or is not on the network at all — answers `{"channels":
  []}`; the two are indistinguishable from this session's view.

  Channels whose NAMES burst has not landed yet (joined but pre-366)
  are EXCLUDED: their member list is unknowable, and reporting the
  peer as absent there would read as "not in common" for a channel
  they are about to turn out to share. Unknown slug, no credential,
  or wrong-user network all collapse to 404 `not_found` via
  `Plugs.ResolveNetwork`. `:no_session` (registered user but session
  not running) also collapses to 404 via `FallbackController`'s
  `:no_session` clause (S14 oracle close). A missing or blank `nick`
  query param is 400 `bad_request`.
  """
  @spec index(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :bad_request | :no_session}
  def index(conn, params) do
    with {:ok, nick} <- fetch_nick(params) do
      subject = Subject.to_session(conn.assigns.current_subject)
      network = conn.assigns.network

      case Session.common_channels(subject, network.id, nick) do
        {:ok, channels} -> render(conn, :index, channels: channels)
        {:error, _} = err -> err
      end
    end
  end

  # The `nick` query param, validated: present, a string, non-blank.
  # Anything else is 400 — a door that answers "no shared channels"
  # for a missing nick would let a client bug read as an empty answer.
  @spec fetch_nick(map()) :: {:ok, String.t()} | {:error, :bad_request}
  defp fetch_nick(%{"nick" => nick}) when is_binary(nick) do
    if String.trim(nick) == "", do: {:error, :bad_request}, else: {:ok, nick}
  end

  defp fetch_nick(_), do: {:error, :bad_request}
end
