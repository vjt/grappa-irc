defmodule Grappa.E2eKeys.DeviceTest do
  @moduledoc """
  issue 2430, multi-device — the key shapes grappa accepts. The `did`
  derivation is wire, so its vectors live in the E2E conformance corpus
  every implementation reads (`Grappa.E2eVectorsTest`, issue 2691).
  """
  use ExUnit.Case, async: true

  alias Grappa.E2eFixtures
  alias Grappa.E2eKeys.Device

  # RFC 8032's first Ed25519 test public key (d75a9801…511a).
  @rfc8032_key "11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo"

  test "key?/1 takes vodozemac's form only: 32 bytes, unpadded, canonical" do
    assert Device.key?(E2eFixtures.identity().public)
    assert Device.key?(E2eFixtures.curve25519())
    refute Device.key?(@rfc8032_key <> "=")
    refute 31 |> :crypto.strong_rand_bytes() |> Base.encode64(padding: false) |> Device.key?()
    refute Device.key?(nil)
    # The same 32 bytes spelled with nonzero trailing bits ("o" → "p")
    # decode alike in a lenient decoder; only one spelling is the key.
    refute Device.key?(String.replace_suffix(@rfc8032_key, "o", "p"))
  end

  test "signature?/1 takes a 64-byte signature, unpadded" do
    signature = E2eFixtures.sign(E2eFixtures.identity(), "anything")
    assert Device.signature?(signature)
    refute Device.signature?(signature <> "==")
    refute Device.signature?(E2eFixtures.identity().public)
  end
end
