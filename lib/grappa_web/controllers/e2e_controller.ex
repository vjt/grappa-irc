defmodule GrappaWeb.E2eController do
  @moduledoc """
  The send door for end-to-end encrypted queries (issue 2430).

  The client encrypts; grappa frames, paces and relays. A peer's message
  arrives as an `e2e_message` event on the user topic the moment it is
  queued (`Grappa.E2eInbox`); the queue itself is the resource below, so a
  client that was not connected can fetch what waits and acknowledge what
  it has read. It is never scrollback. The E2E identity grappa answers a
  peer's KEYREQ from (`Grappa.E2eKeys`) is a resource too: each device
  registers itself and uploads its own key bundle, the master's signed
  device list is put and read, and the whole identity can be dropped. A
  device copies what it sent to the account's other devices through their
  queues, never IRC (`copy/2`), after claiming one key of each (`claim/2`).

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
  `POST /networks/:network_id/e2e/messages` — `{target, verb, from, to,
  payload}`, plus an optional `priority`. `from` is the sending device's
  `did` and `to` the peer's device, or `*` (wire v2): KEYREQ goes from a
  device to `*`, PKMSG and MSG to a device or to `*` (one body for each of
  several devices), NACK to a device. `payload` is the compact JSON text
  the frame carries as is.

  **202, not 201.** Nothing is created and nothing is stored; the lines may
  still be waiting in the pacer when this returns, and IRC never confirms
  delivery. The body carries the `msgid` grappa chose,
  which is what a peer's `NACK` will name, and what an `e2e_send_dropped`
  push names if the session drops the message unsent after all.

  `priority` is `control`, `reactive` or `text`, and absent means `text`. A
  `control` MSG/PKMSG goes ahead of text within the connection's urgent
  budget (`Grappa.Session.E2ePacer`), a `reactive` one within the peer's
  and the connection's reactive budgets; text keeps its order. Set
  `control` on a MSG/PKMSG that carries a CHAL or an ACK, and `reactive` on
  one that carries the device list a peer asked for (`t:list`,
  `t:listreq`): grappa cannot see inside it. `keyreq` is urgent and `nack`
  reactive whatever it says.

  `expires_at` (optional, protocol 46) is the deadline of the order a
  `control` MSG/PKMSG answers, in unix seconds: the CHAL's own
  `expires_at`. grappa starts the message only if its last line can leave
  2 s before it, so the answer can still be back in time.

  400 `bad_request` for a target that is not a nick, a verb outside
  `keyreq | pkmsg | msg | nack`, a priority outside `control | reactive |
  text`, addresses the verb may not carry, a payload that is not compact
  JSON text (printable ASCII, no space), or an `expires_at` that is not a
  positive integer or rides anything but a `control` MSG/PKMSG; 422
  `unknown_device` when `from` names no device of this subject's stored
  list; 413 `too_large`
  past 32 KiB or 64 lines; 422 `too_late` when `expires_at` can already no
  longer be met; 429 `rate_limited` when the peer's queue (32 text
  messages, 32 lines in each of the urgent and reactive lanes) or the
  connection's (128 urgent and reactive lines, 480 s of text) cannot take
  the whole message:
  refused whole and told, never silently dropped.
  """
  @spec create(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, Session.e2e_send_error()}
  def create(conn, %{"target" => target, "verb" => verb, "from" => from, "to" => to, "payload" => payload} = params)
      when is_binary(target) and is_binary(verb) and is_binary(from) and is_binary(to) and is_binary(payload) do
    with {:ok, verb} <- fetch(@verbs, verb),
         {:ok, priority} <- fetch(@priorities, Map.get(params, "priority", "text")),
         {:ok, expires_at} <- expires_at(params),
         {:ok, msgid} <-
           Session.send_e2e(
             subject(conn),
             conn.assigns.network.id,
             target,
             verb,
             priority,
             {from, to},
             payload,
             expires_at
           ) do
      conn |> put_status(:accepted) |> json(SessionWire.e2e_sent(msgid))
    end
  end

  def create(_, _), do: {:error, :bad_request}

  # Absent or null is no deadline; anything else must be an integer, which
  # `Session.send_e2e/8` judges.
  @spec expires_at(map()) :: {:ok, integer() | nil} | {:error, :bad_request}
  defp expires_at(params) do
    case Map.get(params, "expires_at") do
      nil -> {:ok, nil}
      seconds when is_integer(seconds) -> {:ok, seconds}
      _ -> {:error, :bad_request}
    end
  end

  @doc """
  `GET /networks/:network_id/e2e/devices/:did/inbox` — the messages
  waiting for that device, oldest first, at most `E2eInbox.page_size/0`.
  Each is the `e2e_message` the user topic pushes, `id` included.
  `?after=<id>` pages past the last id seen; 400 for one that is not a
  non-negative integer, 404 for a `did` that is not one of this subject's
  devices here.
  """
  @spec inbox(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :bad_request | :not_found}
  def inbox(conn, %{"did" => did} = params) do
    with {:ok, after_id} <- cursor(Map.get(params, "after", "0")),
         {:ok, device} <- E2eKeys.device(subject(conn), conn.assigns.network.id, did) do
      json(conn, SessionWire.e2e_inbox(conn.assigns.network.slug, device.did, E2eInbox.list(device, after_id)))
    end
  end

  @doc """
  `POST /networks/:network_id/e2e/devices/:did/inbox/ack` — `{ids}`: that
  device has read these; they are deleted. 204. An id that is gone
  already, or waits for another device, is skipped: one device
  acknowledging never takes a message from another. 400 unless `ids` is a
  non-empty list of positive integers, at most a page long; 404 for a
  `did` that is not one of this subject's devices here.
  """
  @spec ack(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :bad_request | :not_found | :db_unavailable}
  def ack(conn, %{"did" => did, "ids" => [_ | _] = ids}) do
    if length(ids) <= E2eInbox.page_size() and Enum.all?(ids, &(is_integer(&1) and &1 > 0 and &1 <= @max_id)) do
      with {:ok, device} <- E2eKeys.device(subject(conn), conn.assigns.network.id, did),
           :ok <- E2eInbox.ack(device, ids) do
        send_resp(conn, :no_content, "")
      end
    else
      {:error, :bad_request}
    end
  end

  def ack(_, _), do: {:error, :bad_request}

  @doc """
  `POST /networks/:network_id/e2e/devices` — `{ed25519, curve25519, sig}`:
  registers a device of this subject on this network, or replaces the id
  block of the one it already is. 200 with the device, `did` included: the
  routing label grappa derived from `ed25519`, which the device then names
  as its `from` and its own routes' `:did`.

  400 `bad_request` for an id block that is not two keys and a signature;
  409 `too_many_devices` when the subject already holds four other devices
  there (`DELETE` an unlisted one to make room).
  """
  @spec register_device(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :bad_request | :too_many_devices | :db_unavailable}
  def register_device(conn, params) do
    attrs = %{ed25519: params["ed25519"], curve25519: params["curve25519"], sig: params["sig"]}

    with {:ok, device} <- E2eKeys.register_device(subject(conn), conn.assigns.network.id, attrs) do
      json(conn, E2eKeysWire.device(device))
    end
  end

  @doc """
  `GET /networks/:network_id/e2e/devices` — this subject's devices on this
  network, oldest first, listed or not: `{devices: [device]}`.
  """
  @spec devices(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def devices(conn, _) do
    devices = E2eKeys.devices(subject(conn), conn.assigns.network.id)
    json(conn, E2eKeysWire.devices(devices))
  end

  @doc """
  `DELETE /networks/:network_id/e2e/devices/:did` — drops a device the
  stored list does not name (a pairing that never finished), with its keys
  and its queue, freeing its room. 204. 404 for a `did` that is not one of
  this subject's devices here; 409 `listed_device` for one the list names:
  that one goes with a list that leaves it out.
  """
  @spec remove_device(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :not_found | :listed_device | :db_unavailable}
  def remove_device(conn, %{"did" => did}) do
    with :ok <- E2eKeys.remove_device(subject(conn), conn.assigns.network.id, did) do
      send_resp(conn, :no_content, "")
    end
  end

  @doc """
  `PUT /networks/:network_id/e2e/list` — `{master, ver, devices, sig}`: the
  device list the master signed, which grappa serves in every KEYS it
  answers and routes by. A device the held list names and this one does
  not is revoked: grappa forgets it and everything stored for it. 200 with
  the list.

  400 `bad_request` for a list that is malformed or whose signature does
  not verify; 409 `master_mismatch` when a list is held under another
  master, 409 `stale_list` when `ver` does not rise above the held one (the
  very list held, put again, is a 200 and changes nothing);
  422 `unknown_device` when it names a key no device of this subject
  registered here. Either way nothing changes.
  """
  @spec put_list(Plug.Conn.t(), map()) ::
          Plug.Conn.t()
          | {:error, :bad_request | :master_mismatch | :stale_list | :unknown_device | :db_unavailable}
  def put_list(conn, params) do
    attrs = %{master: params["master"], ver: params["ver"], devices: params["devices"], sig: params["sig"]}

    with {:ok, list} <- E2eKeys.put_list(subject(conn), conn.assigns.network.id, attrs) do
      json(conn, E2eKeysWire.list(list))
    end
  end

  @doc "`GET /networks/:network_id/e2e/list` — the device list held. 404 before one is stored."
  @spec list(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :not_found}
  def list(conn, _) do
    with {:ok, list} <- E2eKeys.list(subject(conn), conn.assigns.network.id) do
      json(conn, E2eKeysWire.list(list))
    end
  end

  @doc """
  `GET /networks/:network_id/e2e/devices/:did/keys` — what that device's
  key bundle still holds: `{one_time_keys, fallback}`. grappa hands the
  keys out to peers that ask; a device replenishes when the count runs
  low. The keys themselves never come back out. 404 for a `did` that is
  not one of this subject's devices here.
  """
  @spec keys(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :not_found}
  def keys(conn, %{"did" => did}) do
    with {:ok, device} <- E2eKeys.device(subject(conn), conn.assigns.network.id, did) do
      json(conn, E2eKeysWire.status(E2eKeys.status(device)))
    end
  end

  @doc """
  `POST /networks/:network_id/e2e/devices/:did/keys` — `{one_time_keys,
  fallback}`, both optional (absent or `null`) but not both: keys as
  `{key, sig}`, the Curve25519 key and the device's signature over
  `"irc-e2e:v1:otk:" + key`. One-time keys are added, each once (a key
  already held is skipped, so a retried upload is harmless); a fallback key
  replaces the one held. 200 with what the bundle then holds, as `GET`
  answers it.

  400 `bad_request` for an upload with nothing in it, a field of the wrong
  type, or a key that is not a key and a signature; 404 for a `did` that is
  not one of this subject's devices here; 413 `too_large` when the bundle
  would hold more than 50 one-time keys. Either way nothing is stored.
  """
  @spec upload_keys(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :bad_request | :not_found | :too_large | :db_unavailable}
  def upload_keys(conn, %{"did" => did} = params) do
    with {:ok, upload} <- upload_params(params),
         {:ok, device} <- E2eKeys.device(subject(conn), conn.assigns.network.id, did),
         {:ok, status} <- E2eKeys.upload(device, upload) do
      json(conn, E2eKeysWire.status(status))
    end
  end

  @doc """
  `POST /networks/:network_id/e2e/devices/:did/claim` — `{from_did}`: one
  key of the sibling device `did`, for the caller's own device `from_did`
  to open an Olm session to it (the copy of an encrypted message goes to
  the account's other devices). 200 `{keys}`: the KEYS v2 text a peer's
  KEYREQ would be answered with, restricted to that one device. The key
  is consumed: a one-time key is never handed out twice, the fallback key
  stays.

  400 `bad_request` without a `from_did`; 404 for a `did` the stored list
  does not name for this subject; 422 `unknown_device` when `from_did` is
  not listed either; 409 `self` for the caller's own `did`, 409 `empty`
  when that device holds no key, 409 `gone` when its key was taken meanwhile.
  """
  @spec claim(Plug.Conn.t(), map()) ::
          Plug.Conn.t()
          | {:error, :bad_request | :self | :unknown_device | :not_found | :empty | :gone | :db_unavailable}
  def claim(conn, %{"did" => did, "from_did" => from_did}) when is_binary(did) and is_binary(from_did) do
    with {:ok, keys} <- E2eKeys.claim(subject(conn), conn.assigns.network.id, from_did, did) do
      json(conn, %{keys: keys})
    end
  end

  def claim(_, _), do: {:error, :bad_request}

  @doc """
  `POST /networks/:network_id/e2e/devices/:did/copies` — `{from_did, verb,
  payload}`: a copy of a message the caller's device `from_did` just sent,
  encrypted by that device to its sibling `did`, so the account's other
  devices show what any of them sent. It goes into that sibling's queue
  flagged `own`, under our nick and a msgid grappa picks, and is pushed as
  an `e2e_message` with `own: true`; it never goes on IRC and raises no
  OS notification. `verb` is `pkmsg` or `msg`, spelled as on the send
  door; `payload` the compact JSON text, as there.

  **202** `{id, msgid}`: the queue id of the copy and its msgid.

  400 `bad_request` for another verb or a payload that is not compact JSON
  text; 404 for a `did` the stored list does not name, or with no session
  on the network (as a send); 409 `self` for the caller's own `did`, 409
  `gone` when that device was dropped meanwhile; 413 `too_large` past 32
  KiB, 413 `full` when the sibling's queue, or its share of the account's
  own copies, cannot take it: that copy is then simply missing there, and
  nobody is told later; 422 `unknown_device` when `from_did` is not listed.
  """
  @spec copy(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, Session.e2e_copy_error()}
  def copy(conn, %{"did" => did, "from_did" => from_did, "verb" => verb, "payload" => payload})
      when is_binary(did) and is_binary(from_did) and is_binary(verb) and is_binary(payload) do
    with {:ok, verb} <- fetch(@verbs, verb),
         {:ok, entry} <- Session.copy_e2e(subject(conn), conn.assigns.network.id, from_did, did, verb, payload) do
      conn |> put_status(:accepted) |> json(SessionWire.e2e_copied(entry))
    end
  end

  def copy(_, _), do: {:error, :bad_request}

  @doc """
  `DELETE /networks/:network_id/e2e/keys` — drops this subject's whole E2E
  identity on this network: every device with its keys, and the device
  list. What a client does when the account starts over with a new master,
  so no peer is handed a key of the old one. 204.
  """
  @spec clear_keys(Plug.Conn.t(), map()) :: Plug.Conn.t() | {:error, :db_unavailable}
  def clear_keys(conn, _) do
    with :ok <- E2eKeys.clear(subject(conn), conn.assigns.network.id) do
      send_resp(conn, :no_content, "")
    end
  end

  @spec subject(Plug.Conn.t()) :: Grappa.Subject.t()
  defp subject(conn), do: Subject.to_session(conn.assigns.current_subject)

  @spec upload_params(map()) :: {:ok, E2eKeys.upload()} | {:error, :bad_request}
  defp upload_params(params) do
    # Absent and `null` mean the same, for both fields.
    otks = Map.get(params, "one_time_keys") || []
    fallback = Map.get(params, "fallback")

    with true <- is_list(otks),
         {:ok, otks} <- signed_keys(otks, []),
         {:ok, fallback} <- signed_key(fallback) do
      {:ok, %{one_time_keys: otks, fallback: fallback}}
    else
      _ -> {:error, :bad_request}
    end
  end

  @spec signed_keys([term()], [E2eKeys.signed_key()]) :: {:ok, [E2eKeys.signed_key()]} | :error
  defp signed_keys([], acc), do: {:ok, Enum.reverse(acc)}

  defp signed_keys([h | t], acc) do
    case signed_key(h) do
      {:ok, %{} = key} -> signed_keys(t, [key | acc])
      _ -> :error
    end
  end

  # The shape only: `E2eKeys.upload/2` judges the key and the signature.
  @spec signed_key(term()) :: {:ok, E2eKeys.signed_key() | nil} | :error
  defp signed_key(nil), do: {:ok, nil}

  defp signed_key(%{"key" => key, "sig" => sig}) when is_binary(key) and is_binary(sig),
    do: {:ok, %{key: key, sig: sig}}

  defp signed_key(_), do: :error

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
