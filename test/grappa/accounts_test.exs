defmodule Grappa.AccountsTest do
  use Grappa.DataCase, async: true

  alias Grappa.Accounts
  alias Grappa.Accounts.User

  @password "correct horse battery staple"

  describe "create_user/1" do
    test "persists a user and Argon2-hashes the password" do
      assert {:ok, %User{} = user} =
               Accounts.create_user(%{name: "vjt", password: @password})

      assert user.name == "vjt"
      assert is_binary(user.password_hash)
      refute user.password_hash == @password
      assert Argon2.verify_pass(@password, user.password_hash)
    end

    test "rejects a duplicate name with a unique-constraint error" do
      assert {:ok, _} = Accounts.create_user(%{name: "vjt", password: @password})

      assert {:error, %Ecto.Changeset{} = cs} =
               Accounts.create_user(%{name: "vjt", password: @password})

      assert "has already been taken" in errors_on(cs).name
    end

    test "rejects a too-short password" do
      assert {:error, %Ecto.Changeset{} = cs} =
               Accounts.create_user(%{name: "vjt", password: "short"})

      assert errors_on(cs)[:password] != nil
    end

    test "rejects an empty name" do
      assert {:error, %Ecto.Changeset{} = cs} =
               Accounts.create_user(%{name: "", password: @password})

      assert errors_on(cs)[:name] != nil
    end

    test "rejects a name with disallowed characters" do
      assert {:error, %Ecto.Changeset{} = cs} =
               Accounts.create_user(%{name: "1bad", password: @password})

      assert errors_on(cs)[:name] != nil
    end
  end

  describe "get_user_by_credentials/2" do
    setup do
      {:ok, user} = Accounts.create_user(%{name: "vjt", password: @password})
      %{user: user}
    end

    test "returns {:ok, user} for valid credentials", %{user: user} do
      assert {:ok, %User{id: id}} = Accounts.get_user_by_credentials("vjt", @password)
      assert id == user.id
    end

    test "returns {:error, :invalid_credentials} for the wrong password" do
      assert {:error, :invalid_credentials} =
               Accounts.get_user_by_credentials("vjt", "wrong password")
    end

    test "returns {:error, :invalid_credentials} for a nonexistent user" do
      assert {:error, :invalid_credentials} =
               Accounts.get_user_by_credentials("nonexistent", "anything goes")
    end
  end

  describe "get_user!/1" do
    test "returns the user by id" do
      {:ok, user} = Accounts.create_user(%{name: "vjt", password: @password})
      assert %User{id: id} = Accounts.get_user!(user.id)
      assert id == user.id
    end

    test "raises Ecto.NoResultsError on miss" do
      assert_raise Ecto.NoResultsError, fn ->
        Accounts.get_user!(Ecto.UUID.generate())
      end
    end
  end

  defp errors_on(changeset) do
    Ecto.Changeset.traverse_errors(changeset, fn {msg, opts} ->
      Regex.replace(~r"%{(\w+)}", msg, fn _, key ->
        opts |> Keyword.get(String.to_existing_atom(key), key) |> to_string()
      end)
    end)
  end
end
