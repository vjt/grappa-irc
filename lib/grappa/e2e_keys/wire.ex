defmodule Grappa.E2eKeys.Wire do
  @moduledoc """
  The wire shape of a subject's E2E identity on a network (issue 2430,
  multi-device), as the `/networks/:network_id/e2e/*` routes answer it: a
  device's public id block and the `did` that addresses it, the signed
  device list, and how much of a device's key bundle is left. Every field
  is public key material or a count; nothing secret is ever held to send.
  The keys a bundle holds never come back out over the client wire.
  """

  use Boundary, top_level?: true, deps: [Grappa.E2eKeys]

  alias Grappa.E2eKeys
  alias Grappa.E2eKeys.{Device, DeviceList}

  @typedoc """
  A device: `did`, the routing label grappa derives from `ed25519` (what a
  frame's `<from>`/`<to>` names), and its id block — `curve25519`,
  `ed25519`, and `sig`, the device's signature over its Curve25519 key and
  the master.
  """
  @type device :: %{did: String.t(), ed25519: String.t(), curve25519: String.t(), sig: String.t()}

  @typedoc "The subject's devices on a network, oldest first, listed or not."
  @type devices :: %{devices: [device()]}

  @typedoc """
  The signed device list: `master`, the subject's master Ed25519 key;
  `ver`, the list's version; `devices`, the Ed25519 keys of the listed
  devices, sorted; `sig`, the master's signature over them.
  """
  @type device_list :: %{master: String.t(), ver: pos_integer(), devices: [String.t()], sig: String.t()}

  @typedoc """
  `one_time_keys`: one-time keys left to hand out. `fallback`: whether a
  fallback key is held, handed out once the one-time keys run out.
  """
  @type status :: %{one_time_keys: non_neg_integer(), fallback: boolean()}

  @typedoc """
  issue 2430 S1 — `POST /networks/:network_id/e2e/devices/:did/claim`
  (200): `keys`, one key of a sibling device as the KEYS v2 text a peer's
  KEYREQ is answered with, restricted to that device (`E2eKeys.claim/4`).
  """
  @type claimed :: %{keys: String.t()}

  @doc "Projects a `Grappa.E2eKeys.Device` onto the wire."
  @spec device(Device.t()) :: device()
  def device(%Device{did: did, ed25519: ed25519, curve25519: curve25519, sig: sig}),
    do: %{did: did, ed25519: ed25519, curve25519: curve25519, sig: sig}

  @doc "Projects `Grappa.E2eKeys.devices/2` onto the wire."
  @spec devices([Device.t()]) :: devices()
  def devices(devices) when is_list(devices), do: %{devices: Enum.map(devices, &device/1)}

  @doc "Projects a `Grappa.E2eKeys.DeviceList` onto the wire."
  @spec list(DeviceList.t()) :: device_list()
  def list(%DeviceList{master: master, ver: ver, devices: devices, sig: sig}),
    do: %{master: master, ver: ver, devices: devices, sig: sig}

  @doc "Projects the KEYS text `Grappa.E2eKeys.claim/4` answers onto the wire."
  @spec claimed(String.t()) :: claimed()
  def claimed(keys) when is_binary(keys), do: %{keys: keys}

  @doc "Projects `Grappa.E2eKeys.status/1` onto the wire."
  @spec status(E2eKeys.status()) :: status()
  def status(%{one_time_keys: count, fallback: fallback?}) when is_integer(count) and is_boolean(fallback?),
    do: %{one_time_keys: count, fallback: fallback?}
end
