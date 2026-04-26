defmodule Mix.Tasks.Grappa.UpdateNetworkCredentialTest do
  # async: false — see add_server_test.exs for rationale.
  use Grappa.DataCase, async: false

  import ExUnit.CaptureIO

  alias Grappa.{Accounts, Networks}
  alias Mix.Tasks.Grappa.UpdateNetworkCredential

  setup do
    {:ok, user} = Accounts.create_user(%{name: "vjt", password: "correct horse battery staple"})
    {:ok, network} = Networks.find_or_create_network(%{slug: "azzurra"})

    {:ok, _} =
      Networks.bind_credential(user, network, %{
        nick: "old-nick",
        password: "old-pw",
        auth_method: :auto,
        autojoin_channels: ["#old"]
      })

    %{user: user, network: network}
  end

  test "updates nick + password + autojoin", %{user: user, network: network} do
    output =
      capture_io(fn ->
        UpdateNetworkCredential.run([
          "--user",
          "vjt",
          "--network",
          "azzurra",
          "--nick",
          "new-nick",
          "--password",
          "new-pw",
          "--autojoin",
          "#new1,#new2"
        ])
      end)

    assert output =~ "updated credential for vjt on azzurra"

    cred = Networks.get_credential!(user, network)
    assert cred.nick == "new-nick"
    assert cred.password_encrypted == "new-pw"
    assert cred.autojoin_channels == ["#new1", "#new2"]
    assert cred.auth_method == :auto
  end

  test "updates auth_method when a fresh --password is supplied", %{user: user, network: network} do
    capture_io(fn ->
      UpdateNetworkCredential.run([
        "--user",
        "vjt",
        "--network",
        "azzurra",
        "--auth",
        "nickserv_identify",
        "--password",
        "fresh-ns-pw"
      ])
    end)

    cred = Networks.get_credential!(user, network)
    assert cred.auth_method == :nickserv_identify
    assert cred.password_encrypted == "fresh-ns-pw"
    assert cred.nick == "old-nick"
    assert cred.autojoin_channels == ["#old"]
  end

  test "preserves password_encrypted when only nick changes", %{user: user, network: network} do
    capture_io(fn ->
      UpdateNetworkCredential.run([
        "--user",
        "vjt",
        "--network",
        "azzurra",
        "--nick",
        "renamed-only"
      ])
    end)

    cred = Networks.get_credential!(user, network)
    assert cred.nick == "renamed-only"
    assert cred.password_encrypted == "old-pw"
    assert cred.auth_method == :auto
  end

  test "halts on invalid auth_method" do
    assert_raise Mix.Error, fn ->
      capture_io(fn ->
        UpdateNetworkCredential.run([
          "--user",
          "vjt",
          "--network",
          "azzurra",
          "--auth",
          "garbage"
        ])
      end)
    end
  end

  test "raises when user is unknown" do
    assert_raise Ecto.NoResultsError, fn ->
      capture_io(fn ->
        UpdateNetworkCredential.run([
          "--user",
          "ghost",
          "--network",
          "azzurra",
          "--nick",
          "x"
        ])
      end)
    end
  end
end
