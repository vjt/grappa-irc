defmodule Grappa.E2eKeys do
  @moduledoc """
  The E2E identity grappa hosts for a subject on a network (issue 2430,
  multi-device; wire v2, 2430 comments 6346236542, 6346384093 and
  6346686730): the subject's devices, its signed device list, and each
  device's key bundle, so a peer's KEYREQ is answered while no client of
  the subject is connected.

  A device registers its id block (`register_device/3`), the master signs
  the list of devices it vouches for (`put_list/3`), and each device
  uploads its own one-time keys and fallback key (`upload/2`). When a peer
  asks, `Grappa.Session.Server` has `answer/3` compose one KEYS covering
  every listed device: the list, then each device's id block and its
  oldest one-time key, or its fallback key when none is left. `consume/1`
  deletes the one-time keys it handed out, so each goes out once; the
  fallback key stays. Clients replenish when they connect.

  grappa decides no trust. It checks the shape of every key and signature,
  and verifies exactly one signature, the list's (`DeviceList`): without
  that a stolen bearer could SILENTLY lock out a revocation. A swapped key
  is caught by the peer, which pins the master.

  ## Bounds

  At most `DeviceList.max_devices/0` devices per subject and network, and
  per device at most `max_one_time_keys/0` one-time keys (vodozemac's own
  ceiling on the keys an account publishes) and one fallback key; a new
  fallback key replaces the old. An upload past any bound is refused whole. A one-time
  key already held is skipped rather than stored twice, so a client
  retrying an upload whose answer it lost never has one key handed to two
  peers.

  Known gap: a one-time key handed out between an upload and its retry is
  stored again by the retry. The peer that later gets it opens a session
  the device can no longer decrypt (the key is gone from its account), and
  recovers through NACK and a re-key.

  ## Boundary

  Deps: `Grappa.Repo`, `Grappa.Subject`. The `belongs_to` references in
  the schemas carry no edge.
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.Repo, Grappa.Subject],
    exports: [Device, DeviceList, Key]

  import Ecto.Query

  alias Grappa.E2eKeys.{Device, DeviceList, Key}
  alias Grappa.{Repo, Subject}

  @max_one_time_keys 50

  @typedoc "A key as a device uploads it: the Curve25519 key and the device's signature over `\"irc-e2e:v1:otk:\" + key`."
  @type signed_key :: %{key: String.t(), sig: String.t()}

  @typedoc "What a device uploads: one-time keys, and a fallback key or `nil`."
  @type upload :: %{one_time_keys: [signed_key()], fallback: signed_key() | nil}

  @typedoc "How much of a device's bundle is left."
  @type status :: %{one_time_keys: non_neg_integer(), fallback: boolean()}

  @doc """
  Registers a device of `subject` on `network_id` from its id block
  (`%{ed25519, curve25519, sig}`), under the `did` derived from its
  Ed25519 key. A device already registered replaces its id block (it
  re-signs it when the subject's master changes) and stays one device.

  `{:error, :bad_request}` for an id block that is not two keys and a
  signature; `{:error, :too_many_devices}` when the subject already holds
  `DeviceList.max_devices/0` other devices there. The count and the insert
  are one transaction, so two registrations cannot both take the last room.
  `{:error, :db_unavailable}` when the write lock stays taken past the
  retry budget.
  """
  @spec register_device(Subject.t(), integer(), map()) ::
          {:ok, Device.t()} | {:error, :bad_request | :too_many_devices | :db_unavailable}
  def register_device({_, _} = subject, network_id, attrs) when is_integer(network_id) and is_map(attrs) do
    changeset =
      Device.changeset(
        %Device{},
        attrs
        |> Map.take([:ed25519, :curve25519, :sig])
        |> Map.put(:network_id, network_id)
        |> Subject.put_subject_id(subject)
      )

    if changeset.valid?,
      do: Repo.BusyRetry.run(fn -> register_transaction(subject, network_id, changeset) end),
      else: {:error, :bad_request}
  end

  @spec register_transaction(Subject.t(), integer(), Ecto.Changeset.t()) ::
          {:ok, Device.t()} | {:error, :too_many_devices}
  defp register_transaction(subject, network_id, changeset) do
    did = Ecto.Changeset.get_field(changeset, :did)

    Repo.immediate_transaction(fn ->
      subject |> device_query(network_id, did) |> Repo.one() |> register(subject, network_id, changeset)
    end)
  end

  # Inside the transaction: a device already held gets the new id block;
  # a new one takes a room, if one is left.
  @spec register(Device.t() | nil, Subject.t(), integer(), Ecto.Changeset.t()) :: Device.t()
  defp register(%Device{} = held, _, _, changeset),
    do: held |> Ecto.Changeset.change(Map.take(changeset.changes, [:curve25519, :sig])) |> Repo.update!()

  defp register(nil, subject, network_id, changeset) do
    if Repo.aggregate(devices_query(subject, network_id), :count) < DeviceList.max_devices(),
      do: Repo.insert!(changeset),
      else: Repo.rollback(:too_many_devices)
  end

  @doc """
  Drops a device of `subject` on `network_id` that the stored list does not
  name — one whose pairing never finished — with everything stored for it,
  so it no longer takes one of the `DeviceList.max_devices/0` rooms. A
  listed device goes only with a list that leaves it out (`put_list/3`):
  its removal is the master's signed act.

  `{:error, :not_found}` for a `did` naming no device of the subject there;
  `{:error, :listed_device}` for one the stored list names.
  `{:error, :db_unavailable}` when the write lock stays taken past the
  retry budget.
  """
  @spec remove_device(Subject.t(), integer(), String.t()) ::
          :ok | {:error, :not_found | :listed_device | :db_unavailable}
  def remove_device({_, _} = subject, network_id, did) when is_integer(network_id) and is_binary(did) do
    case Repo.BusyRetry.run(fn -> remove_transaction(subject, network_id, did) end) do
      {:ok, %Device{}} -> :ok
      {:error, _} = err -> err
    end
  end

  @spec remove_transaction(Subject.t(), integer(), String.t()) ::
          {:ok, Device.t()} | {:error, :not_found | :listed_device}
  defp remove_transaction(subject, network_id, did) do
    Repo.immediate_transaction(fn ->
      listed = subject |> list_query(network_id) |> select([l], l.devices) |> Repo.one() |> List.wrap()
      subject |> device_query(network_id, did) |> Repo.one() |> remove(listed)
    end)
  end

  # Inside the transaction: the device's keys and queue go with its row.
  @spec remove(Device.t() | nil, [String.t()]) :: Device.t()
  defp remove(nil, _), do: Repo.rollback(:not_found)

  defp remove(%Device{ed25519: key} = device, listed),
    do: if(key in listed, do: Repo.rollback(:listed_device), else: Repo.delete!(device))

  @doc "The devices of `subject` on `network_id`, oldest first."
  @spec devices(Subject.t(), integer()) :: [Device.t()]
  def devices({_, _} = subject, network_id) when is_integer(network_id),
    do: subject |> devices_query(network_id) |> order_by([d], asc: d.id) |> Repo.all()

  @doc "The device of `subject` on `network_id` that `did` names. `{:error, :not_found}` when there is none."
  @spec device(Subject.t(), integer(), String.t()) :: {:ok, Device.t()} | {:error, :not_found}
  def device({_, _} = subject, network_id, did) when is_integer(network_id) and is_binary(did) do
    case Repo.one(device_query(subject, network_id, did)) do
      %Device{} = device -> {:ok, device}
      nil -> {:error, :not_found}
    end
  end

  @doc """
  Stores the signed device list of `subject` on `network_id`
  (`%{master, ver, devices, sig}`, see `Grappa.E2eKeys.DeviceList`).

  A device the previous list held and this one does not is revoked: its
  row goes, and with it everything stored for it, so grappa neither routes
  to it nor serves its keys again. A device registered but never listed
  (one being paired) is left alone.

  `{:error, :bad_request}` for a list that is malformed or whose signature
  does not verify; `{:error, :master_mismatch}` when a list is already
  held under another master (a new identity starts over with `clear/2`);
  `{:error, :stale_list}` when `ver` does not rise above the held one,
  unless the list is the very one held, which answers `{:ok, list}` and
  changes nothing (a retried put);
  `{:error, :unknown_device}` when it lists a key no device of the subject
  registered there. Either way nothing changes.
  `{:error, :db_unavailable}` when the write lock stays taken past the
  retry budget.
  """
  @spec put_list(Subject.t(), integer(), map()) ::
          {:ok, DeviceList.t()}
          | {:error, :bad_request | :master_mismatch | :stale_list | :unknown_device | :db_unavailable}
  def put_list({_, _} = subject, network_id, attrs) when is_integer(network_id) and is_map(attrs) do
    changeset =
      DeviceList.changeset(
        %DeviceList{},
        attrs
        |> Map.take([:master, :ver, :devices, :sig])
        |> Map.put(:network_id, network_id)
        |> Subject.put_subject_id(subject)
      )

    if changeset.valid?,
      do: Repo.BusyRetry.run(fn -> put_list_transaction(subject, network_id, changeset) end),
      else: {:error, :bad_request}
  end

  @spec put_list_transaction(Subject.t(), integer(), Ecto.Changeset.t()) ::
          {:ok, DeviceList.t()} | {:error, :master_mismatch | :stale_list | :unknown_device}
  defp put_list_transaction(subject, network_id, changeset) do
    new = Ecto.Changeset.apply_changes(changeset)

    Repo.immediate_transaction(fn ->
      held = Repo.one(list_query(subject, network_id))
      registered = subject |> devices_query(network_id) |> select([d], d.ed25519) |> Repo.all()

      cond do
        held != nil and held.master != new.master -> Repo.rollback(:master_mismatch)
        # The list already held, put again: a client retrying a put whose
        # answer it lost is answered as the first time.
        held != nil and {held.ver, held.devices, held.sig} == {new.ver, new.devices, new.sig} -> held
        held != nil and new.ver <= held.ver -> Repo.rollback(:stale_list)
        not Enum.all?(new.devices, &(&1 in registered)) -> Repo.rollback(:unknown_device)
        true -> replace_list(subject, network_id, held, changeset)
      end
    end)
  end

  # Inside the transaction: the revoked devices go, then the list is
  # written over the held one.
  @spec replace_list(Subject.t(), integer(), DeviceList.t() | nil, Ecto.Changeset.t()) :: DeviceList.t()
  defp replace_list(subject, network_id, held, changeset) do
    revoked = if held, do: held.devices -- Ecto.Changeset.get_field(changeset, :devices), else: []
    {_, _} = subject |> devices_query(network_id) |> where([d], d.ed25519 in ^revoked) |> Repo.delete_all()

    case held do
      nil ->
        Repo.insert!(changeset)

      %DeviceList{} ->
        held
        |> Ecto.Changeset.change(Map.take(changeset.changes, [:ver, :devices, :sig]))
        |> Repo.update!()
    end
  end

  @doc "The signed device list of `subject` on `network_id`. `{:error, :not_found}` before one is stored."
  @spec list(Subject.t(), integer()) :: {:ok, DeviceList.t()} | {:error, :not_found}
  def list({_, _} = subject, network_id) when is_integer(network_id) do
    case Repo.one(list_query(subject, network_id)) do
      %DeviceList{} = list -> {:ok, list}
      nil -> {:error, :not_found}
    end
  end

  @doc """
  The devices of `subject` on `network_id` the stored list names, in the
  list's order: the ones grappa routes to and sends for (wire v2). `[]`
  before a list is stored. A device registered but not listed — one being
  paired — is not among them.
  """
  @spec listed_devices(Subject.t(), integer()) :: [Device.t()]
  def listed_devices({_, _} = subject, network_id) when is_integer(network_id) do
    case Repo.one(list_query(subject, network_id)) do
      %DeviceList{} = list -> listed(subject, network_id, list)
      nil -> []
    end
  end

  @spec listed(Subject.t(), integer(), DeviceList.t()) :: [Device.t()]
  defp listed(subject, network_id, %DeviceList{devices: keys}) do
    by_key =
      subject
      |> devices_query(network_id)
      |> where([d], d.ed25519 in ^keys)
      |> Repo.all()
      |> Map.new(&{&1.ed25519, &1})

    for key <- keys, %Device{} = device <- [Map.get(by_key, key)], do: device
  end

  @spec list_query(Subject.t(), integer()) :: Ecto.Query.t()
  defp list_query(subject, network_id),
    do: DeviceList |> Subject.subject_where(subject) |> where([l], l.network_id == ^network_id)

  @spec devices_query(Subject.t(), integer()) :: Ecto.Query.t()
  defp devices_query(subject, network_id),
    do: Device |> Subject.subject_where(subject) |> where([d], d.network_id == ^network_id)

  @spec device_query(Subject.t(), integer(), String.t()) :: Ecto.Query.t()
  defp device_query(subject, network_id, did),
    do: subject |> devices_query(network_id) |> where([d], d.did == ^did)

  @doc "One-time keys one device may hold."
  @spec max_one_time_keys() :: 50
  def max_one_time_keys, do: @max_one_time_keys

  @doc """
  Adds `one_time_keys` to the bundle of `device`, and replaces its
  fallback key when `fallback` is given. Each key is `%{key, sig}`: the
  Curve25519 key and the device's signature over `"irc-e2e:v1:otk:" +
  key`. Returns what the bundle then holds.

  `{:error, :bad_request}` for an upload with nothing in it, or a key that
  is not a key and a signature (`Grappa.E2eKeys.Device`); `{:error,
  :too_large}` when the bundle would pass `max_one_time_keys/0`;
  `{:error, :not_found}` when the device was revoked or dropped since the
  caller read it. Either way nothing is stored. `{:error, :db_unavailable}`
  when the write lock stays taken past the retry budget.
  """
  @spec upload(Device.t(), upload()) ::
          {:ok, status()} | {:error, :bad_request | :too_large | :not_found | :db_unavailable}
  def upload(%Device{} = device, %{one_time_keys: otks, fallback: fallback})
      when is_list(otks) and (is_map(fallback) or is_nil(fallback)) do
    # A one-time key is one key: the same one twice is the same key, and
    # handing it to two peers breaks the second one's session.
    otks = Enum.uniq_by(otks, &key_of/1)

    # An upload that could never fit is refused before a changeset is built.
    if length(otks) > @max_one_time_keys do
      {:error, :too_large}
    else
      changesets =
        Enum.map(otks, &key_changeset(device, :otk, &1)) ++
          if(fallback, do: [key_changeset(device, :fallback, fallback)], else: [])

      store_valid(device, changesets)
    end
  end

  # Anything but a key map is kept as it is, for its changeset to refuse.
  @spec key_of(term()) :: term()
  defp key_of(%{key: key}), do: key
  defp key_of(other), do: other

  @spec store_valid(Device.t(), [Ecto.Changeset.t()]) ::
          {:ok, status()} | {:error, :bad_request | :too_large | :not_found | :db_unavailable}
  defp store_valid(_, []), do: {:error, :bad_request}

  defp store_valid(device, changesets) do
    if Enum.all?(changesets, & &1.valid?),
      do: Repo.BusyRetry.run(fn -> upload_transaction(device, changesets) end),
      else: {:error, :bad_request}
  end

  @spec key_changeset(Device.t(), Key.kind(), term()) :: Ecto.Changeset.t()
  defp key_changeset(device, kind, signed) when is_map(signed),
    do: Key.changeset(%Key{}, signed |> Map.take([:key, :sig]) |> Map.merge(%{device_id: device.id, kind: kind}))

  defp key_changeset(device, kind, _), do: Key.changeset(%Key{}, %{device_id: device.id, kind: kind})

  # The count check and the inserts are one transaction, so two uploads
  # cannot both squeeze into the last room. A key already held is skipped,
  # not stored twice: a client that never saw the answer to an upload sends
  # the same batch again, and it costs nothing against the bound. The
  # device is checked first: a list put or a clear may have dropped it
  # since it was read, and SQLite names no constraint for the foreign key
  # it would then refuse.
  @spec upload_transaction(Device.t(), [Ecto.Changeset.t(), ...]) ::
          {:ok, status()} | {:error, :too_large | :bad_request | :not_found}
  defp upload_transaction(device, changesets) do
    Repo.immediate_transaction(fn ->
      _ = if not Repo.exists?(where(Device, [d], d.id == ^device.id)), do: Repo.rollback(:not_found)
      held = device |> keys_query(:otk) |> select([k], k.key) |> Repo.all() |> MapSet.new()
      new = Enum.reject(changesets, &held_otk?(&1, held))
      adding = Enum.count(new, &(Ecto.Changeset.get_field(&1, :kind) == :otk))

      if MapSet.size(held) + adding > @max_one_time_keys,
        do: Repo.rollback(:too_large),
        else: store(device, new)
    end)
  end

  @spec held_otk?(Ecto.Changeset.t(), MapSet.t(String.t())) :: boolean()
  defp held_otk?(changeset, held),
    do:
      Ecto.Changeset.get_field(changeset, :kind) == :otk and
        MapSet.member?(held, Ecto.Changeset.get_field(changeset, :key))

  # Inside the transaction: a new fallback key replaces the old one. A key
  # the device holds under the other kind collides on the (device, key)
  # index and refuses the whole upload: one key is never both.
  @spec store(Device.t(), [Ecto.Changeset.t()]) :: status()
  defp store(device, changesets) do
    _ =
      if Enum.any?(changesets, &(Ecto.Changeset.get_field(&1, :kind) == :fallback)),
        do: Repo.delete_all(keys_query(device, :fallback))

    Enum.each(changesets, fn changeset ->
      case Repo.insert(changeset) do
        {:ok, _} -> :ok
        {:error, _} -> Repo.rollback(:bad_request)
      end
    end)

    status(device)
  end

  @doc "How many one-time keys `device` has left, and whether it has a fallback key."
  @spec status(Device.t()) :: status()
  def status(%Device{} = device) do
    %{
      one_time_keys: Repo.aggregate(keys_query(device, :otk), :count),
      fallback: Repo.exists?(keys_query(device, :fallback))
    }
  end

  @doc """
  The KEYS payload to answer a peer's KEYREQ for `subject` on
  `network_id`, and the keys it hands out (wire v2, 2430 comments
  6346236542 and 6346686730): the signed device list, then, for each
  listed device that still has a key, its id block and one key. Asked for
  `:otk`, a device's oldest one-time key, or its fallback key when none is
  left; asked for `:fallback`, only fallback keys.

  The payload is the compact JSON text a frame carries as is:

      {"v":2,"master":{"ed25519":M,"list":{"ver":N,"devices":[E,…]},"sig":S},
       "devices":[{"id":{"curve25519":K,"ed25519":E,"sig":S1},
                   "otk":{"key":O,"fallback":false,"sig":S2}},…]}

  `{:error, :empty}` when no list is stored, or no listed device has a key
  left. Nothing is removed: `consume/1` does that once the caller is sure
  it will send the payload.
  """
  @spec answer(Subject.t(), integer(), Key.kind()) :: {:ok, String.t(), [Key.t(), ...]} | {:error, :empty}
  def answer({_, _} = subject, network_id, kind) when is_integer(network_id) and kind in [:otk, :fallback] do
    with %DeviceList{} = list <- Repo.one(list_query(subject, network_id)),
         [_ | _] = entries <- entries(subject, network_id, list, kind) do
      {:ok, Jason.encode!(%{v: 2, master: master_block(list), devices: Enum.map(entries, &entry_block/1)}),
       Enum.map(entries, &elem(&1, 1))}
    else
      _ -> {:error, :empty}
    end
  end

  @doc """
  One key of a sibling device, for the device `from_did` of the same
  account to open an Olm session to it (S1, issue 2430: the copy of an
  encrypted message a device sends to the account's other devices).

  The payload is `answer/3`'s KEYS v2, restricted to the one device `did`:
  the signed list, then that device's id block and its oldest one-time key,
  or its fallback key when none is left. The key is consumed here (a
  one-time key is deleted, the fallback stays), since the payload goes
  straight to the caller and nowhere else.

  The pair is `sibling/4`'s refusals; then `{:error, :keyless_device}`
  when that device holds no key at all; `{:error, :key_taken}` when its key
  was taken between the pick and the consume (ask again); `{:error,
  :db_unavailable}` when the write lock stays taken past the retry budget.
  """
  @spec claim(Subject.t(), integer(), String.t(), String.t()) ::
          {:ok, String.t()} | {:error, sibling_error() | :keyless_device | :key_taken | :db_unavailable}
  def claim({_, _} = subject, network_id, from_did, did)
      when is_integer(network_id) and is_binary(from_did) and is_binary(did) do
    with {:ok, list, device} <- sibling(subject, network_id, from_did, did),
         {:ok, key} <- claimable_key(device),
         :ok <- consume([key]) do
      {:ok, Jason.encode!(%{v: 2, master: master_block(list), devices: [entry_block({device, key})]})}
    end
  end

  # The key a claim hands out: the oldest one-time key, else the fallback.
  @spec claimable_key(Device.t()) :: {:ok, Key.t()} | {:error, :keyless_device}
  defp claimable_key(device) do
    case next_key(device, :otk) do
      %Key{} = key -> {:ok, key}
      nil -> {:error, :keyless_device}
    end
  end

  @typedoc "Why `sibling/4` refuses a pair of devices."
  @type sibling_error :: :same_device | :unknown_device | :not_found

  @doc """
  issue 2430 S1 — the one rule both sibling doors apply, the claim
  (`claim/4`) and the copy (`Grappa.Session.copy_e2e/6`): the device `did`
  is a sibling of the device `from_did` when the two differ and the
  subject's stored list names both. One read of the list.

  `{:ok, list, device}`: the stored list and the sibling's device.
  `{:error, :same_device}` when `did` is `from_did`, before anything is
  read; `{:error, :unknown_device}` when the list does not name `from_did`
  (or none is stored); `{:error, :not_found}` when it does not name `did`
  for this subject.
  """
  @spec sibling(Subject.t(), integer(), String.t(), String.t()) ::
          {:ok, DeviceList.t(), Device.t()} | {:error, sibling_error()}
  def sibling({_, _} = subject, network_id, from_did, did)
      when is_integer(network_id) and is_binary(from_did) and is_binary(did) do
    with :ok <- if(did == from_did, do: {:error, :same_device}, else: :ok),
         %DeviceList{} = list <- Repo.one(list_query(subject, network_id)) || {:error, :unknown_device},
         listed = listed(subject, network_id, list),
         true <- Enum.any?(listed, &(&1.did == from_did)) || {:error, :unknown_device},
         %Device{} = device <- Enum.find(listed, &(&1.did == did)) || {:error, :not_found} do
      {:ok, list, device}
    end
  end

  # Listed devices in the list's own order, each with the key it hands out;
  # a device with none left is not in the answer, and so not reachable for
  # now.
  @spec entries(Subject.t(), integer(), DeviceList.t(), Key.kind()) :: [{Device.t(), Key.t()}]
  defp entries(subject, network_id, list, kind),
    do: for(device <- listed(subject, network_id, list), %Key{} = key <- [next_key(device, kind)], do: {device, key})

  @spec next_key(Device.t(), Key.kind()) :: Key.t() | nil
  defp next_key(device, :otk) do
    case device |> keys_query(:otk) |> order_by([k], asc: k.id) |> limit(1) |> Repo.one() do
      %Key{} = key -> key
      nil -> next_key(device, :fallback)
    end
  end

  defp next_key(device, :fallback), do: Repo.one(keys_query(device, :fallback))

  @spec master_block(DeviceList.t()) :: map()
  defp master_block(%DeviceList{} = list),
    do: %{ed25519: list.master, list: %{ver: list.ver, devices: list.devices}, sig: list.sig}

  @spec entry_block({Device.t(), Key.t()}) :: map()
  defp entry_block({%Device{} = device, %Key{} = key}) do
    %{
      id: %{curve25519: device.curve25519, ed25519: device.ed25519, sig: device.sig},
      otk: %{key: key.key, fallback: key.kind == :fallback, sig: key.sig}
    }
  end

  @doc """
  Marks `keys` as handed out, all or none: each one-time key is deleted, so
  it is never handed out again; each fallback key stays. `{:error,
  :key_taken}` when any of them is no longer held — taken already, or dropped with its
  device, by `clear/2` or by a newer fallback key — and then nothing is
  deleted, so a KEYS picked before a client changed its bundle is never
  sent after.
  """
  #
  # By id alone: ids are never reused (the table is `AUTOINCREMENT`) and a
  # row never changes kind, so the id names the very key that was picked.
  @spec consume([Key.t(), ...]) :: :ok | {:error, :key_taken | :db_unavailable}
  def consume([%Key{} | _] = keys) do
    otks = for %Key{kind: :otk, id: id} <- keys, do: id
    fallbacks = for %Key{kind: :fallback, id: id} <- keys, do: id

    case Repo.BusyRetry.run(fn -> consume_transaction(otks, fallbacks) end) do
      {:ok, :ok} -> :ok
      {:error, _} = err -> err
    end
  end

  @spec consume_transaction([pos_integer()], [pos_integer()]) :: {:ok, :ok} | {:error, :key_taken}
  defp consume_transaction(otks, fallbacks) do
    Repo.immediate_transaction(fn ->
      {deleted, _} = Repo.delete_all(where(Key, [k], k.id in ^otks))
      held = Repo.aggregate(where(Key, [k], k.id in ^fallbacks), :count)
      if deleted == length(otks) and held == length(fallbacks), do: :ok, else: Repo.rollback(:key_taken)
    end)
  end

  @doc """
  Drops everything `subject` holds on `network_id`: its devices, with
  their keys, and its device list. What a client does when the account
  starts over with a new identity, so no peer is handed a key of the old
  one and the new master's first list is accepted.
  """
  @spec clear(Subject.t(), integer()) :: :ok | {:error, :db_unavailable}
  def clear({_, _} = subject, network_id) when is_integer(network_id) do
    result =
      Repo.BusyRetry.run(fn ->
        Repo.immediate_transaction(fn ->
          {_, _} = Repo.delete_all(devices_query(subject, network_id))
          {_, _} = Repo.delete_all(list_query(subject, network_id))
          :ok
        end)
      end)

    case result do
      {:ok, :ok} -> :ok
      {:error, :db_unavailable} = err -> err
    end
  end

  @spec keys_query(Device.t(), Key.kind()) :: Ecto.Query.t()
  defp keys_query(%Device{id: device_id}, kind),
    do: where(Key, [k], k.device_id == ^device_id and k.kind == ^kind)
end
