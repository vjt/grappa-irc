defmodule Grappa.Accounts.AdminWireTest do
  @moduledoc """
  Pure projection tests for `Grappa.Accounts.AdminWire`. Constructs
  a `%User{}` literal with `password_hash` + `password` populated so
  the credential-material absence assertion has bite.
  """
  use ExUnit.Case, async: true

  alias Grappa.Accounts.{AdminWire, User}

  describe "user_to_admin_json/2" do
    test "projects every admin-relevant field" do
      now = DateTime.utc_now()

      user = %User{
        id: "11111111-1111-1111-1111-111111111111",
        name: "vjt",
        is_admin: true,
        password_hash: "argon2-hash-not-shown",
        password: "plaintext-not-shown",
        inserted_at: now,
        updated_at: now
      }

      assert %{
               id: "11111111-1111-1111-1111-111111111111",
               name: "vjt",
               is_admin: true,
               inserted_at: ^now,
               updated_at: ^now,
               live_session_count: 3
             } = AdminWire.user_to_admin_json(user, 3)
    end

    test "live_session_count of 0 round-trips as 0" do
      now = DateTime.utc_now()
      user = %User{id: "a", name: "x", is_admin: false, inserted_at: now, updated_at: now}

      assert %{live_session_count: 0} = AdminWire.user_to_admin_json(user, 0)
    end

    test "NEVER includes password_hash or password (credential material exclusion)" do
      now = DateTime.utc_now()

      user = %User{
        id: "22222222-2222-2222-2222-222222222222",
        name: "secrets",
        is_admin: false,
        password_hash: "$argon2id$v=19$REDACTED",
        password: "plaintext-MUST-NEVER-LEAK",
        inserted_at: now,
        updated_at: now
      }

      json = AdminWire.user_to_admin_json(user, 0)

      refute Map.has_key?(json, :password)
      refute Map.has_key?(json, :password_hash)

      refute Enum.any?(json, fn {_, v} ->
               is_binary(v) and String.contains?(v, ["argon2", "MUST-NEVER-LEAK"])
             end)
    end
  end
end
