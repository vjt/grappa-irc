defmodule Grappa.Networks.WireTest do
  @moduledoc """
  Tests for `Grappa.Networks.Wire` — the public JSON shape for
  `Networks.Credential` and `Networks.Network` rows.

  The CRITICAL invariant: the credential JSON output MUST NOT include
  `:password_encrypted` (which post-Cloak-load carries the upstream
  IRC password as plaintext-in-memory) NOR the virtual `:password`
  field (input-only, but defensively excluded too). `redact: true`
  on the schema only protects `inspect/1` and Logger; `Jason.encode!/1`
  walks the struct fields directly. Without an explicit allowlist
  serializer, the first naive Phase 3 `GET /networks` controller
  emitting `Jason.encode!(credential)` would leak the NickServ
  password to JSON.
  """
  use Grappa.DataCase, async: true

  alias Grappa.{Accounts, Networks, Repo}
  alias Grappa.Networks.{Credential, Credentials, Wire}

  setup do
    {:ok, user} =
      Accounts.create_user(%{
        name: "vjt-#{System.unique_integer([:positive])}",
        password: "correct horse battery"
      })

    {:ok, network} =
      Networks.find_or_create_network(%{slug: "azzurra-#{System.unique_integer([:positive])}"})

    %{user: user, network: network}
  end

  describe "credential_to_json/1" do
    test "renders the public credential shape (slug under :network)",
         %{user: user, network: network} do
      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          realname: "Marcello",
          sasl_user: "vjt",
          auth_method: :sasl,
          password: "shibboleth",
          autojoin_channels: ["#grappa"]
        })

      cred = user |> Credentials.get_credential!(network) |> Repo.preload(:network)

      json = Wire.credential_to_json(cred)

      assert json.network == network.slug
      assert json.nick == "vjt"
      assert json.realname == "Marcello"
      assert json.sasl_user == "vjt"
      assert json.auth_method == :sasl
      assert json.autojoin_channels == ["#grappa"]
      assert %DateTime{} = json.inserted_at
      assert %DateTime{} = json.updated_at
    end

    # CRITICAL — the whole point of this module. If this assertion ever
    # regresses, the next deployed `GET /networks` endpoint leaks the
    # upstream NickServ password to the world.
    test "NEVER includes :password_encrypted nor :password",
         %{user: user, network: network} do
      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          auth_method: :nickserv_identify,
          password: "leak-canary-please-never-appear"
        })

      cred = user |> Credentials.get_credential!(network) |> Repo.preload(:network)

      # Sanity-check the precondition: post-load Cloak has decrypted
      # the AES-GCM ciphertext into plaintext-in-memory.
      assert cred.password_encrypted == "leak-canary-please-never-appear"

      json = Wire.credential_to_json(cred)

      refute Map.has_key?(json, :password_encrypted)
      refute Map.has_key?(json, :password)

      # And the canary string must not appear ANYWHERE in the JSON
      # (defends against a future field that accidentally carries it).
      json_string = Jason.encode!(json)
      refute json_string =~ "leak-canary-please-never-appear"
    end

    test "crashes loudly on unloaded :network assoc",
         %{user: user, network: network} do
      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          auth_method: :none
        })

      cred = Credentials.get_credential!(user, network)
      # `get_credential!/2` returns the row WITHOUT preloading :network.
      assert match?(%Ecto.Association.NotLoaded{}, cred.network)

      assert_raise FunctionClauseError, fn -> Wire.credential_to_json(cred) end
    end

    test "is Jason-encodable without raising",
         %{user: user, network: network} do
      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          auth_method: :none
        })

      cred = user |> Credentials.get_credential!(network) |> Repo.preload(:network)

      assert is_binary(Jason.encode!(Wire.credential_to_json(cred)))
    end
  end

  describe "network_to_json/1" do
    test "renders the public network shape", %{network: network} do
      json = Wire.network_to_json(network)

      assert json.id == network.id
      assert json.slug == network.slug
      assert %DateTime{} = json.inserted_at
      assert %DateTime{} = json.updated_at
    end

    test "is Jason-encodable", %{network: network} do
      assert is_binary(Jason.encode!(Wire.network_to_json(network)))
    end
  end

  describe "Credential.upstream_password/1" do
    test "returns the post-Cloak-load plaintext upstream secret",
         %{user: user, network: network} do
      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          auth_method: :server_pass,
          password: "shibboleth"
        })

      cred = Credentials.get_credential!(user, network)

      assert Credential.upstream_password(cred) == "shibboleth"
    end

    test "returns nil for :none credentials with no stored password",
         %{user: user, network: network} do
      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          auth_method: :none
        })

      cred = Credentials.get_credential!(user, network)

      assert Credential.upstream_password(cred) == nil
    end
  end

  # Defense-in-depth: prove that handing the raw schema struct to
  # Jason — i.e., what a naive controller might do before A1 was
  # written — would have leaked. This isn't a regression test for the
  # Wire module itself; it's a contract on the schema's behaviour
  # under JSON encoding so future readers understand WHY Wire exists.
  describe "raw-struct Jason regression canary" do
    test "raw Credential leaks password_encrypted (this is what Wire prevents)",
         %{user: user, network: network} do
      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          auth_method: :sasl,
          password: "DO-NOT-LEAK"
        })

      cred = Credentials.get_credential!(user, network)

      # Jason can't encode an Ecto schema struct without `@derive` —
      # the raw struct path either raises Protocol.UndefinedError OR,
      # if a future @derive opens it up, leaks. Assert the current
      # state is the safe one (raise) so a future @derive Jason.Encoder
      # on Credential trips this canary and forces the author to use
      # Wire.credential_to_json/1 instead.
      assert_raise Protocol.UndefinedError, fn -> Jason.encode!(cred) end
    end

    test "raw Network leaks fields too (this is what Wire prevents)",
         %{network: network} do
      assert_raise Protocol.UndefinedError, fn -> Jason.encode!(network) end
    end
  end
end
