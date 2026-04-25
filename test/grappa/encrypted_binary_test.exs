defmodule Grappa.EncryptedBinaryTest do
  @moduledoc """
  Property-tests the `Grappa.EncryptedBinary` Ecto type wired against
  the running `Grappa.Vault`. Exercises the dump→load round-trip
  (the Ecto.Type contract Cloak hands us) and asserts ciphertext varies
  per encryption (IV randomisation smoke test). End-to-end DB persistence
  is exercised in sub-task 2d via `network_credentials.password_encrypted`.
  """

  use ExUnit.Case, async: true
  use ExUnitProperties

  alias Grappa.EncryptedBinary

  property "round-trips arbitrary binaries via dump/load" do
    check all(bin <- StreamData.binary()) do
      assert {:ok, ciphertext} = EncryptedBinary.dump(bin)
      assert is_binary(ciphertext)
      assert {:ok, ^bin} = EncryptedBinary.load(ciphertext)
    end
  end

  test "ciphertext varies for the same plaintext (IV randomisation)" do
    plaintext = "porco dio"
    assert {:ok, c1} = EncryptedBinary.dump(plaintext)
    assert {:ok, c2} = EncryptedBinary.dump(plaintext)
    refute c1 == c2
    assert {:ok, ^plaintext} = EncryptedBinary.load(c1)
    assert {:ok, ^plaintext} = EncryptedBinary.load(c2)
  end
end
