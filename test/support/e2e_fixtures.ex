defmodule Grappa.E2eFixtures do
  @moduledoc """
  Real key material for the issue 2430 multi-device tests: Ed25519 and
  X25519 keypairs from `:crypto`, encoded the way vodozemac's
  `to_base64()` writes them (standard base64, unpadded), and signatures
  made with the real private keys. A test that checks a shape or a
  signature checks it against what a client really sends, never against a
  string that only looks like a key.
  """
  use Boundary, top_level?: true, deps: [Grappa.E2eKeys]

  alias Grappa.E2eKeys.DeviceList

  @typedoc "An Ed25519 keypair: the public key as the wire writes it, and the raw private key."
  @type identity :: %{public: String.t(), private: binary()}

  @doc "A fresh Ed25519 identity — a device's, or a master."
  @spec identity() :: identity()
  def identity do
    {public, private} = :crypto.generate_key(:eddsa, :ed25519)
    %{public: b64(public), private: private}
  end

  @doc "Signs the UTF-8 of `message` with `identity`, as the wire writes a signature."
  @spec sign(identity(), String.t()) :: String.t()
  def sign(%{private: private}, message) when is_binary(message),
    do: b64(:crypto.sign(:eddsa, :none, message, [private, :ed25519]))

  @doc "A fresh X25519 public key, as the wire writes it."
  @spec curve25519() :: String.t()
  def curve25519 do
    {public, _} = :crypto.generate_key(:ecdh, :x25519)
    b64(public)
  end

  @doc """
  A device's id block under `master`: a fresh device identity and the
  attrs `Grappa.E2eKeys.register_device/3` takes, its `sig` made by the
  device over `"irc-e2e:v2:id:" + curve25519 + ":" + master`.
  """
  @spec device(identity()) :: %{identity: identity(), attrs: map()}
  def device(%{public: master}) do
    identity = identity()
    curve = curve25519()

    %{
      identity: identity,
      attrs: %{ed25519: identity.public, curve25519: curve, sig: sign(identity, "irc-e2e:v2:id:#{curve}:#{master}")}
    }
  end

  @doc """
  The attrs `Grappa.E2eKeys.put_list/3` takes for a list of `devices`
  (Ed25519 keys) at version `ver`, sorted as the wire requires and signed
  by `master`.
  """
  @spec list(identity(), pos_integer(), [String.t(), ...]) :: map()
  def list(%{public: public} = master, ver, [_ | _] = devices) do
    devices = Enum.sort(devices)
    %{master: public, ver: ver, devices: devices, sig: sign(master, DeviceList.signed_string(ver, devices))}
  end

  @doc """
  A key as `Grappa.E2eKeys.upload/2` takes it: a fresh Curve25519 key and
  `identity`'s signature over `"irc-e2e:v1:otk:" + key`.
  """
  @spec signed_key(identity()) :: %{key: String.t(), sig: String.t()}
  def signed_key(identity) do
    key = curve25519()
    %{key: key, sig: sign(identity, "irc-e2e:v1:otk:" <> key)}
  end

  @spec b64(binary()) :: String.t()
  defp b64(raw), do: Base.encode64(raw, padding: false)
end
