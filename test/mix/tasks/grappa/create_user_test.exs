defmodule Mix.Tasks.Grappa.CreateUserTest do
  @moduledoc """
  Smoke-tests the `mix grappa.create_user` CLI entry point.

  The error-path (invalid changeset → `System.halt/1`) cannot be
  exercised in-process — `System.halt/1` kills the BEAM unconditionally.
  That branch is covered indirectly: the Accounts.create_user/1
  invariants live in `Grappa.AccountsTest`, and the operator
  bind-network smoke pass (sub-task 2k) re-checks the CLI end-to-end.
  """
  use Grappa.DataCase, async: true

  import ExUnit.CaptureIO

  alias Grappa.Accounts
  alias Mix.Tasks.Grappa.CreateUser

  test "creates a user and prints its name + id" do
    output =
      capture_io(fn ->
        CreateUser.run([
          "--name",
          "vjt",
          "--password",
          "correct horse battery staple"
        ])
      end)

    assert output =~ "created user vjt"
    assert {:ok, _} = Accounts.get_user_by_credentials("vjt", "correct horse battery staple")
  end

  test "raises when --name is missing" do
    assert_raise KeyError, fn ->
      CreateUser.run(["--password", "correct horse battery staple"])
    end
  end

  test "raises when --password is missing" do
    assert_raise KeyError, fn ->
      CreateUser.run(["--name", "vjt"])
    end
  end
end
