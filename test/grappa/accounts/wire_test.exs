defmodule Grappa.Accounts.WireTest do
  @moduledoc """
  Tests for `Grappa.Accounts.Wire` — the public JSON shape for
  `Accounts.User` rows.

  The CRITICAL invariant: neither the full `user_to_json/1` shape
  nor the minimal `user_to_credential_json/1` shape MAY include
  `:password_hash` (Argon2id digest) or the virtual `:password`
  field. `redact: true` on the schema only protects `inspect/1` and
  Logger; `Jason.encode!/1` walks struct fields directly. Without
  an explicit allowlist serializer, a controller that does
  `json(conn, user)` leaks the password hash to the world.
  """
  use Grappa.DataCase, async: true

  alias Grappa.Accounts
  alias Grappa.Accounts.Wire

  setup do
    {:ok, user} =
      Accounts.create_user(%{
        name: "vjt-#{System.unique_integer([:positive])}",
        password: "leak-canary-please-never-appear"
      })

    %{user: user}
  end

  describe "user_to_json/1" do
    test "renders the full profile shape", %{user: user} do
      json = Wire.user_to_json(user)

      assert json.id == user.id
      assert json.name == user.name
      assert %DateTime{} = json.inserted_at
    end

    # CRITICAL — if this regresses, `GET /me` leaks the Argon2 hash.
    test "NEVER includes :password_hash nor :password", %{user: user} do
      json = Wire.user_to_json(user)

      refute Map.has_key?(json, :password_hash)
      refute Map.has_key?(json, :password)

      # And neither the hash nor the canary plaintext appears
      # anywhere in the encoded JSON (defends against a future
      # field that accidentally carries either).
      json_string = Jason.encode!(json)
      refute json_string =~ user.password_hash
      refute json_string =~ "leak-canary-please-never-appear"
    end

    test "is Jason-encodable without raising", %{user: user} do
      assert is_binary(Jason.encode!(Wire.user_to_json(user)))
    end
  end

  describe "user_to_credential_json/1" do
    test "renders the minimal credential-exchange shape", %{user: user} do
      json = Wire.user_to_credential_json(user)

      assert json.id == user.id
      assert json.name == user.name
      # Login response deliberately omits inserted_at — credential-
      # exchange surface, not profile lookup.
      refute Map.has_key?(json, :inserted_at)
    end

    test "NEVER includes :password_hash nor :password", %{user: user} do
      json = Wire.user_to_credential_json(user)

      refute Map.has_key?(json, :password_hash)
      refute Map.has_key?(json, :password)

      json_string = Jason.encode!(json)
      refute json_string =~ user.password_hash
      refute json_string =~ "leak-canary-please-never-appear"
    end

    test "is Jason-encodable without raising", %{user: user} do
      assert is_binary(Jason.encode!(Wire.user_to_credential_json(user)))
    end
  end

  # Defense-in-depth: prove that handing the raw schema struct to
  # Jason — i.e., what a naive controller might do before A5 was
  # written — would have leaked. This isn't a regression test for the
  # Wire module itself; it's a contract on the schema's behaviour
  # under JSON encoding so future readers understand WHY Wire exists.
  describe "raw-struct Jason regression canary" do
    test "raw User raises Protocol.UndefinedError (this is what Wire prevents)",
         %{user: user} do
      # Jason can't encode an Ecto schema struct without `@derive` —
      # the raw struct path either raises Protocol.UndefinedError OR,
      # if a future @derive opens it up, leaks. Assert the current
      # state is the safe one (raise) so a future @derive Jason.Encoder
      # on User trips this canary and forces the author to use
      # Wire.user_to_json/1 instead.
      assert_raise Protocol.UndefinedError, fn -> Jason.encode!(user) end
    end
  end
end
