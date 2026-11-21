defmodule GrappaWeb.CommonChannelsController do
  @moduledoc """
  Channels in common with a given nick, for the query window (issue 2449).
  Source-of-truth is `Grappa.Session.common_channels/3` — the live
  `Session.Server.state.members` map, read in-memory with no IRC round
  trip and no DB write.

  Snapshot endpoint, not subscription. Cicchetto fetches on query
  open/focus (cold start + the zero-shared-channels ambiguity) and
  derives live updates from its own `membersByChannel` map, which
  `applyPresenceEvent` already maintains from the existing JOIN/PART/
  KICK/QUIT/NICK pushes — no new push event.

  Iso boundary: `Plugs.ResolveNetwork` collapses unknown-slug /
  not-your-network to 404 BEFORE this action runs. The `:no_session`
  tag from `Session.common_channels/3` collapses to the same 404 wire
  body via `FallbackController` (same shape as `MembersController`).
  """
  use GrappaWeb, :controller

  alias Grappa.Session
  alias GrappaWeb.Subject

  @doc """
  `GET /networks/:network_id/common-channels?nick=<nick>` — returns the
  sorted list of channels the caller shares with `nick` on this network.

  Only channels whose NAMES burst has landed count: a channel joined but
  pre-366 is EXCLUDED, not reported as "not shared" (its member list is
  unknowable yet — same seeded discrimination as `list_members/3`).
  The nick is folded with the network casemapping inside the session,
  so any case answers alike.

  Missing or empty `nick` → 400 `bad_request` via `FallbackController`.
  Unknown slug, no credential, or wrong-user network → 404 `not_found`
  via `Plugs.ResolveNetwork`. `:no_session` (registered user but
  session not running) → 404 via `FallbackController`'s `:no_session`
  clause (same as `MembersController`).
  """
  @spec index(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :no_session | :bad_request}
  def index(conn, %{"nick" => nick}) when is_binary(nick) do
    if String.trim(nick) == "" do
      {:error, :bad_request}
    else
      subject = Subject.to_session(conn.assigns.current_subject)
      network = conn.assigns.network

      case Session.common_channels(subject, network.id, nick) do
        {:ok, channels} -> render(conn, :index, channels: channels)
        {:error, _} = err -> err
      end
    end
  end

  def index(_, _), do: {:error, :bad_request}
end
