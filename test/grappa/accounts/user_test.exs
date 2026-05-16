defmodule Grappa.Accounts.UserTest do
  use ExUnit.Case, async: true

  alias Grappa.Accounts.User

  @valid_attrs %{name: "vjt", password: "correct horse battery staple"}

  describe "changeset/2" do
    test "valid for fully-populated attrs" do
      cs = User.changeset(%User{}, @valid_attrs)
      assert cs.valid?
      assert cs.changes.name == "vjt"
      assert is_binary(cs.changes.password_hash)
      refute cs.changes.password_hash == @valid_attrs.password
    end

    test "rejects missing name" do
      cs = User.changeset(%User{}, Map.delete(@valid_attrs, :name))
      refute cs.valid?
      assert cs.errors[:name] != nil
    end

    test "rejects missing password" do
      cs = User.changeset(%User{}, Map.delete(@valid_attrs, :password))
      refute cs.valid?
      assert cs.errors[:password] != nil
    end

    test "rejects name shorter than 1 char" do
      cs = User.changeset(%User{}, %{@valid_attrs | name: ""})
      refute cs.valid?
      assert cs.errors[:name] != nil
    end

    test "rejects name longer than 64 chars" do
      cs = User.changeset(%User{}, %{@valid_attrs | name: String.duplicate("a", 65)})
      refute cs.valid?
      assert cs.errors[:name] != nil
    end

    test "rejects name not starting with a letter" do
      for bad <- ["1abc", "_vjt", "-vjt", " vjt"] do
        cs = User.changeset(%User{}, %{@valid_attrs | name: bad})
        refute cs.valid?, "expected #{inspect(bad)} to be invalid"
        assert cs.errors[:name] != nil
      end
    end

    test "rejects name with disallowed characters" do
      for bad <- ["vjt!", "vjt@home", "vjt.x", "vjt/x", "v j t"] do
        cs = User.changeset(%User{}, %{@valid_attrs | name: bad})
        refute cs.valid?, "expected #{inspect(bad)} to be invalid"
        assert cs.errors[:name] != nil
      end
    end

    test "accepts well-formed names" do
      for ok <- ["vjt", "v", "Marcello", "user_1", "a-b-c", "abc123"] do
        cs = User.changeset(%User{}, %{@valid_attrs | name: ok})
        assert cs.valid?, "expected #{inspect(ok)} to be valid"
      end
    end

    test "rejects password shorter than 8 chars" do
      cs = User.changeset(%User{}, %{@valid_attrs | password: "short"})
      refute cs.valid?
      assert cs.errors[:password] != nil
    end

    test "rejects password longer than 256 chars" do
      cs = User.changeset(%User{}, %{@valid_attrs | password: String.duplicate("a", 257)})
      refute cs.valid?
      assert cs.errors[:password] != nil
    end

    test "does NOT compute password_hash when changeset is invalid" do
      cs = User.changeset(%User{}, %{name: "", password: "correct horse battery staple"})
      refute cs.valid?
      refute Map.has_key?(cs.changes, :password_hash)
    end

    test "Argon2.verify_pass accepts the original password" do
      cs = User.changeset(%User{}, @valid_attrs)
      assert Argon2.verify_pass(@valid_attrs.password, cs.changes.password_hash)
    end
  end

  describe "admin_changeset/2" do
    test "accepts is_admin: true" do
      cs = User.admin_changeset(%User{is_admin: false}, %{is_admin: true})
      assert cs.valid?
      assert cs.changes.is_admin == true
    end

    test "accepts is_admin: false (demotion)" do
      cs = User.admin_changeset(%User{is_admin: true}, %{is_admin: false})
      assert cs.valid?
      assert cs.changes.is_admin == false
    end

    test "valid (no-op) when attrs is empty — struct default is non-nil" do
      # The schema's default: false makes validate_required/2 satisfied
      # by the existing struct value, so an empty changeset is a clean
      # no-op rather than an error. The admin controller always passes
      # is_admin explicitly from the request body; this no-op shape is
      # documented invariant of the narrow surface, not a bug.
      cs = User.admin_changeset(%User{}, %{})
      assert cs.valid?
      assert cs.changes == %{}
    end

    test "ignores name / password / password_hash keys (narrow surface)" do
      cs =
        User.admin_changeset(%User{name: "vjt"}, %{
          is_admin: true,
          name: "evil",
          password: "smuggled-password-12345",
          password_hash: "smuggled-hash"
        })

      assert cs.valid?
      assert cs.changes == %{is_admin: true}
    end
  end
end
