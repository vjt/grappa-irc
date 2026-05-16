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
      # M-1: new users default is_admin: false. M cluster's
      # bin/grappa create-user --admin path flips this via
      # update_admin_flags/2 post-insert (Q-FIRST-ADMIN bootstrap).
      assert user.is_admin == false
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

  describe "update_admin_flags/2" do
    setup do
      {:ok, user} = Accounts.create_user(%{name: "vjt", password: @password})
      %{user: user}
    end

    test "toggles is_admin: false → true", %{user: user} do
      assert user.is_admin == false

      assert {:ok, %User{is_admin: true}} =
               Accounts.update_admin_flags(user, %{is_admin: true})

      assert %User{is_admin: true} = Accounts.get_user!(user.id)
    end

    test "toggles is_admin: true → false (demotion)", %{user: user} do
      {:ok, promoted} = Accounts.update_admin_flags(user, %{is_admin: true})

      assert {:ok, %User{is_admin: false}} =
               Accounts.update_admin_flags(promoted, %{is_admin: false})
    end

    test "no-op when attrs is empty (idempotent admin re-save)", %{user: user} do
      # validate_required/2 reads the existing struct value, which
      # defaults to false from the schema — so an empty changeset
      # leaves is_admin unchanged and returns :ok. Documents the
      # narrow-surface contract: callers must pass is_admin
      # explicitly to change it; the admin endpoint controller
      # always provides the boolean from the request body.
      assert {:ok, %User{is_admin: false}} = Accounts.update_admin_flags(user, %{})
    end

    test "ignores name / password keys (narrow surface)", %{user: user} do
      original_name = user.name
      original_hash = user.password_hash

      assert {:ok, %User{} = updated} =
               Accounts.update_admin_flags(user, %{
                 is_admin: true,
                 name: "evil",
                 password: "smuggled-password-12345",
                 password_hash: "smuggled-hash"
               })

      assert updated.is_admin == true
      assert updated.name == original_name
      assert updated.password_hash == original_hash
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
end
