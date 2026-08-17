defmodule Grappa.Accounts.LoginTest do
  @moduledoc """
  The password door's decision, exercised WITHOUT a `conn` (#1395).

  All 64 tests in `auth_controller_test.exs` need a `Plug.Conn` — the user
  ladder had no entry point other than an HTTP action, which is the defect
  this slice addresses. These are the evidence it now has one: the same
  decision, driven through `Grappa.Accounts.Login.authenticate/1` with a
  plain map. The controller tests keep covering the HTTP envelope, the
  throttles and the challenge minting, all of which deliberately stayed at
  the edge.
  """
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Accounts.{Login, TOTP, User}

  defp set_passkey_mode(%User{} = user, mode) do
    {:ok, updated} =
      user
      |> User.passkey_mode_changeset(%{passkey_mode: mode})
      |> Repo.update()

    updated
  end

  # Arms TOTP off a PREVIOUS step so the current one stays unspent.
  # NOTE: `auth_controller_test.exs` carries an identical `arm_totp/1`. That
  # duplication is one of the instances #1397 counts; consolidating it into
  # `Grappa.AuthFixtures` belongs to that issue's slice, not this one.
  defp arm_totp(%User{} = user) do
    enrollment = TOTP.new_enrollment(user, "Grappa test")
    previous_step = System.system_time(:second) - 30
    {:ok, code} = TOTP.code_at(enrollment.secret, previous_step)
    {:ok, _} = TOTP.confirm_enrollment(user, enrollment.secret, code, previous_step)
    user
  end

  describe "authenticate/1 — the credential gate" do
    test "a correct password on an account with no second factor returns the user" do
      {user, password} = user_fixture_with_password()

      assert {:ok, %User{id: id}} = Login.authenticate(%{name: user.name, password: password})
      assert id == user.id
    end

    test "a wrong password is refused as :invalid_credentials" do
      {user, _} = user_fixture_with_password()

      assert {:error, :invalid_credentials} =
               Login.authenticate(%{name: user.name, password: "not-the-password"})
    end

    test "an unknown account name is refused with the SAME token as a wrong password" do
      # The uniform oracle is the point: the caller must not be able to tell
      # which half of the credential was wrong.
      {user, password} = user_fixture_with_password()

      assert Login.authenticate(%{name: "no-such-account", password: password}) ==
               Login.authenticate(%{name: user.name, password: "not-the-password"})
    end

    test "the account name matches the way account names match — folded (#1353)" do
      {user, password} =
        user_fixture_with_password(name: "VJT-#{System.unique_integer([:positive])}")

      assert {:ok, %User{id: id}} =
               Login.authenticate(%{name: String.downcase(user.name), password: password})

      assert id == user.id
    end
  end

  describe "authenticate/1 — which door the account still has to walk through" do
    test "an account in passkey :second_factor mode is sent to the passkey door" do
      {user, password} = user_fixture_with_password()
      set_passkey_mode(user, :second_factor)

      assert {:second_factor, :passkey, %User{id: id}} =
               Login.authenticate(%{name: user.name, password: password})

      assert id == user.id
    end

    test "a :passwordless account refuses the password door even with the right password" do
      # Distinct from :invalid_credentials deliberately. The wire answer is the
      # same 401, but the throttle must NOT be charged: the credential was
      # correct, so this is not a guess.
      {user, password} = user_fixture_with_password()
      set_passkey_mode(user, :passwordless)

      assert {:error, :passwordless} =
               Login.authenticate(%{name: user.name, password: password})
    end

    test "a :passwordless account with a WRONG password is a guess, not a closed door" do
      {user, _} = user_fixture_with_password()
      set_passkey_mode(user, :passwordless)

      assert {:error, :invalid_credentials} =
               Login.authenticate(%{name: user.name, password: "not-the-password"})
    end

    test "an account with TOTP armed is sent to the code door" do
      {user, password} = user_fixture_with_password()
      arm_totp(user)

      assert {:second_factor, :totp, %User{id: id}} =
               Login.authenticate(%{name: user.name, password: password})

      assert id == user.id
    end

    test "passkey :second_factor wins over TOTP when the account holds both" do
      # Order is load-bearing: the passkey branch is decided before TOTP, so an
      # account holding both is offered the passkey.
      {user, password} = user_fixture_with_password()

      user
      |> arm_totp()
      |> set_passkey_mode(:second_factor)

      assert {:second_factor, :passkey, _} =
               Login.authenticate(%{name: user.name, password: password})
    end

    test "a :disabled account with no TOTP takes the no-second-factor exit" do
      # The third arm of the closed `passkey_mode` set, spelled so the exit is
      # exercised rather than inherited from a catch-all.
      {user, password} = user_fixture_with_password()
      set_passkey_mode(user, :disabled)

      assert {:ok, %User{}} = Login.authenticate(%{name: user.name, password: password})
    end
  end
end
