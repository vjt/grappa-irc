defmodule Grappa.E2eKeys.DeviceTest do
  @moduledoc """
  issue 2430, multi-device — the device id and the key shapes grappa
  accepts. The `did` derivation is wire (2430 comment 6346236542, made
  base64url by an amendment), so it is pinned to vectors computed outside
  this codebase.
  """
  use ExUnit.Case, async: true

  alias Grappa.E2eFixtures
  alias Grappa.E2eKeys.Device

  # The two vectors of the base64url amendment on 2430, computed with
  # Python's hashlib and base64.urlsafe_b64encode: RFC 8032's first Ed25519
  # test key (d75a9801…511a), and the raw SHA-256 of "irc-e2e did vector
  # 70" (ee5d35c9…f486), whose did needs both `-` and `_` (in the standard
  # alphabet it would read `/Uw/z3+OAsk`).
  @rfc8032_key "11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo"
  @rfc8032_did "If4x36FUomE"
  @vector70_key "7l01yXGoarYtEU3nwHF01/CIo8/r8U0lJ01TnULT9IY"
  @vector70_did "_Uw_z3-OAsk"

  test "did/1 is the first 8 bytes of SHA-256 over the raw key, unpadded base64url" do
    assert Device.did(@rfc8032_key) == {:ok, @rfc8032_did}
    assert Device.did(@vector70_key) == {:ok, @vector70_did}
  end

  test "did/1 refuses what is not a key" do
    assert Device.did("not a key") == :error
    assert Device.did(String.slice(@rfc8032_key, 0, 42)) == :error
  end

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
