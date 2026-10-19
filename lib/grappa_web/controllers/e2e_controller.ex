defmodule GrappaWeb.E2eController do
  @moduledoc """
  The send door for end-to-end encrypted queries (issue 2430).

  The client encrypts; grappa frames, paces and relays. A peer's message
  arrives as an `e2e_message` event on the user topic the moment it is
  queued (`Grappa.E2eInbox`); the queue itself is the resource below, so a
  client that was not connected can fetch what waits and acknowledge what
  it has read. It is never scrollback. The key bundle grappa answers a
  peer's KEYREQ from (`Grappa.E2eKeys`) is a resource too: the client
  uploads it, reads what is left, and drops it.

  Same `:authn` + `ResolveNetwork` pipeline as every other
  `/networks/:network_id/*` route, so ownership is asserted the same way.
  """
  use GrappaWeb, :controller

  alias Grappa.{E2eInbox, E2eKeys, Session}
  alias Grappa.E2eKeys.Wire, as: E2eKeysWire
  alias Grappa.Session.Wire, as: SessionWire
  alias GrappaWeb.Subject

  # The wire spells verbs lowercase, like every other closed set on it; the
  # set itself is the facade's, so the two cannot drift.
  @verbs Map.new(Session.e2e_send_verbs(), &{Atom.to_string(&1), &1})
  @priorities Map.new(Session.e2e_priorities(), &{Atom.to_string(&1), &1})

  # The int64 the id column is. A larger integer would fail its bind inside
  # exqlite — a 500 for what is a malformed request — so the queue routes
  # refuse it as one.
  @max_id 9_223_372_036_854_775_807

  @doc """
  `POST /networks/:network_id/e2e/messages` — `{target, verb, payload}`, plus
  an optional `priority`.

  **202, not 201.** Nothing is created and nothing is stored; the lines may
  still be waiting in the pacer when this returns, and IRC never confirms
  delivery. The body carries the `msgid` grappa chose,
  which is what a peer's `NACK` will name.

  `priority` is `control` or `text`, and absent means `text`. A `control`
  message always goes ahead of the text queued for the same peer, and ahead
  of other peers' lines within a per-peer budget
  (`Grappa.Session.E2ePacer`); text keeps its order. Set
  `control` on a MSG/PKMSG that carries a CHAL or an ACK: grappa cannot see
  inside it. `keyreq` and `nack` are control whatever it says.

  400 `bad_request` for a target that is not a nick, a verb outside
  `keyreq | pkmsg | msg | nack`, a priority outside `control | text`, or a
  payload that is not base64; 413 `too_large` past 32 KiB or 64 lines; 429
  `rate_limited` when the peer's queue (32 text messages, 32 control lines)
  or the connection's (128 lines) cannot take the whole message: refused
  whole and told, never silently dropped.
  """
  @spec create(Plug.Conn.t(), map()) ::
          Plug.Conn.t()
          | {:error, :bad_request | :invalid_line | :no_session | :no_socket | :timeout | :too_large | :rate_limited}
  def create(conn, %{"target" => target, "verb" => verb, "payload" => payload} = params)
      when is_binary(target) and is_binary(verb) and is_binary(payload) do
    subject = Subject.to_session(conn.assigns.current_subject)

    with {:ok, verb} <- fetch(@verbs, verb),
         {:ok, priority} <- fetch(@priorities, Map.get(params, "priority", "text")),
         {:ok, msgid} <- Session.send_e2e(subject, conn.assigns.network.id, target, verb, priority, payload) do
      conn |> put_status(:accepted) |> json(%{msgid: msgid})
    end
  end

  def create(_, _), do: {:error, :bad_request}

  @doc """
  `GET /networks/:network_id/e2e/inbox` — the messages waiting for this
  subject on this network, oldest first, at most `E2eInbox.page_size/0`.
  Each is the `e2e_message` the user topic pushes, `id` included.
  `?after=<id>` pages past the last id seen; 400 for one that is not a
  non-negative integer.
  """
  @spec inbox(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :bad_request}
  def inbox(conn, params) do
    with {:ok, after_id} <- cursor(Map.get(params, "after", "0")) do
      network = conn.assigns.network
      entries = E2eInbox.list(Subject.to_session(conn.assigns.current_subject), network.id, after_id)
      json(conn, %{messages: Enum.map(entries, &SessionWire.e2e_message(network.slug, &1))})
    end
  end

  @doc """
  `POST /networks/:network_id/e2e/inbox/ack` — `{ids}`: the client has
  read these; they are deleted. 204. An id that is gone already, or is not
  this subject's, is skipped. 400 unless `ids` is a non-empty list of
  positive integers, at most a page long.
  """
  @spec ack(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :bad_request | :db_unavailable}
  def ack(conn, %{"ids" => [_ | _] = ids}) do
    if length(ids) <= E2eInbox.page_size() and Enum.all?(ids, &(is_integer(&1) and &1 > 0 and &1 <= @max_id)) do
      with :ok <- E2eInbox.ack(Subject.to_session(conn.assigns.current_subject), conn.assigns.network.id, ids) do
        send_resp(conn, :no_content, "")
      end
    else
      {:error, :bad_request}
    end
  end

  def ack(_, _), do: {:error, :bad_request}

  @doc """
  `GET /networks/:network_id/e2e/keys` — what this subject's key bundle on
  this network still holds: `{one_time_keys, fallback}`. grappa hands the
  keys out to peers that ask; a client replenishes when the count runs
  low. The keys themselves never come back out.
  """
  @spec keys(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def keys(conn, _) do
    status = E2eKeys.status(Subject.to_session(conn.assigns.current_subject), conn.assigns.network.id)
    json(conn, E2eKeysWire.status(status))
  end

  @doc """
  `POST /networks/:network_id/e2e/keys` — `{one_time_keys, fallback}`, both
  optional but not both absent: KEYS payloads the client built and signed,
  one per one-time key, and one for the fallback key. One-time keys are
  added; a fallback key replaces the one held. 200 with what the bundle
  then holds, as `GET` answers it.

  400 `bad_request` for an upload with nothing in it, a field of the wrong
  type, or a payload that is not base64 or is over 1 KiB; 413 `too_large`
  when the bundle would hold more than 50 one-time keys. Either way nothing
  is stored.
  """
  @spec upload_keys(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :bad_request | :too_large | :db_unavailable}
  def upload_keys(conn, params) do
    with {:ok, upload} <- upload_params(params),
         {:ok, status} <-
           E2eKeys.upload(Subject.to_session(conn.assigns.current_subject), conn.assigns.network.id, upload) do
      json(conn, E2eKeysWire.status(status))
    end
  end

  @doc """
  `DELETE /networks/:network_id/e2e/keys` — drops this subject's whole
  bundle on this network: what a client does when it starts over with a
  new account, so no peer is handed a key of the old one. 204.
  """
  @spec clear_keys(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :db_unavailable}
  def clear_keys(conn, _) do
    with :ok <- E2eKeys.clear(Subject.to_session(conn.assigns.current_subject), conn.assigns.network.id) do
      send_resp(conn, :no_content, "")
    end
  end

  @spec upload_params(map()) :: {:ok, E2eKeys.upload()} | {:error, :bad_request}
  defp upload_params(params) do
    otks = Map.get(params, "one_time_keys", [])
    fallback = Map.get(params, "fallback")

    if is_list(otks) and Enum.all?(otks, &is_binary/1) and (is_binary(fallback) or is_nil(fallback)),
      do: {:ok, %{one_time_keys: otks, fallback: fallback}},
      else: {:error, :bad_request}
  end

  @spec cursor(term()) :: {:ok, non_neg_integer()} | {:error, :bad_request}
  defp cursor(value) when is_binary(value) do
    case Integer.parse(value) do
      {n, ""} when n >= 0 and n <= @max_id -> {:ok, n}
      _ -> {:error, :bad_request}
    end
  end

  defp cursor(_), do: {:error, :bad_request}

  # The wire spells closed sets lowercase; anything else is a 400.
  @spec fetch(%{String.t() => atom()}, term()) :: {:ok, atom()} | {:error, :bad_request}
  defp fetch(set, value) do
    case Map.fetch(set, value) do
      {:ok, _} = ok -> ok
      :error -> {:error, :bad_request}
    end
  end
end
