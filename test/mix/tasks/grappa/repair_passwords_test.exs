defmodule Mix.Tasks.Grappa.RepairPasswordsTest do
  # async: false — see add_server_test.exs for rationale.
  use Grappa.DataCase, async: false

  import ExUnit.CaptureIO
  import Grappa.AuthFixtures, only: [visitor_fixture: 1]

  alias Grappa.{Networks, Repo}
  alias Grappa.Networks.{Credential, Credentials}
  alias Mix.Tasks.Grappa.RepairPasswords

  # The corrupted shape #977 produced: `SET PASSWD <old> <new>` captured
  # rest-of-line, so the stored secret is the two passwords joined by the
  # space `do_set_password` splits on.
  @two_token "oldpass newpass"
  @three_token "oldest older newest"
  # A legitimate SASL passphrase. `auth_fsm.ex:722` base64-encodes it into
  # PLAIN, so the spaces survive and the credential identifies normally —
  # this value is NOT corruption, and repairing it would destroy a live
  # secret.
  @sasl_passphrase "my pass phrase"

  setup do
    {:ok, user} = Grappa.Accounts.create_user(%{name: "vjt", password: "correct horse battery staple"})
    {:ok, network} = Networks.find_or_create_network(%{slug: "azzurra"})

    %{user: user, network: network}
  end

  defp bind(user, network, password, auth_method) do
    {:ok, credential} =
      Credentials.bind_credential(user, network, %{
        nick: "vjt",
        password: password,
        auth_method: auth_method
      })

    credential
  end

  defp reload(%Credential{id: id}), do: Repo.get!(Credential, id)

  describe "classify/1 — the space decides only where Azzurra's rule governs the secret" do
    test "a space-free nickserv password is healthy", %{user: user, network: network} do
      credential = bind(user, network, "hunter2000", :nickserv_identify)

      assert RepairPasswords.classify(credential) == :healthy
    end

    test "two tokens on a nickserv credential repair to the last token", %{user: user, network: network} do
      credential = bind(user, network, @two_token, :nickserv_identify)

      assert RepairPasswords.classify(credential) == {:repairable, "newpass"}
    end

    test "three tokens are reported, never guessed", %{user: user, network: network} do
      credential = bind(user, network, @three_token, :nickserv_identify)

      assert RepairPasswords.classify(credential) == {:report, :multiple_rotations}
    end

    test "a run of spaces is reported, not collapsed into two tokens", %{user: user, network: network} do
      # `do_set_password` splits at the FIRST space and then refuses a
      # `newpass` that still holds one, so this rotation never took
      # upstream — neither token is known to be live.
      credential = bind(user, network, "oldpass  newpass", :nickserv_identify)

      assert RepairPasswords.classify(credential) == {:report, :multiple_rotations}
    end

    test "a trailing space is reported, not silently trimmed", %{user: user, network: network} do
      credential = bind(user, network, "oldpass newpass ", :nickserv_identify)

      assert RepairPasswords.classify(credential) == {:report, :multiple_rotations}
    end

    test "a SASL credential with spaces is reported, NEVER repaired", %{user: user, network: network} do
      credential = bind(user, network, @sasl_passphrase, :sasl)

      assert RepairPasswords.classify(credential) == {:report, :ambiguous_auth_method}
    end

    test "an :auto credential with spaces is reported — it may resolve to SASL", %{user: user, network: network} do
      credential = bind(user, network, @sasl_passphrase, :auto)

      assert RepairPasswords.classify(credential) == {:report, :ambiguous_auth_method}
    end

    test "a :server_pass credential with spaces is reported", %{user: user, network: network} do
      credential = bind(user, network, @sasl_passphrase, :server_pass)

      assert RepairPasswords.classify(credential) == {:report, :ambiguous_auth_method}
    end

    test "a :none credential with spaces is reported", %{user: user, network: network} do
      credential = bind(user, network, @sasl_passphrase, :none)

      assert RepairPasswords.classify(credential) == {:report, :ambiguous_auth_method}
    end

    test "a credential with no stored password is not a candidate", %{user: user, network: network} do
      credential = bind(user, network, nil, :none)

      assert credential.password_encrypted == nil
      assert RepairPasswords.classify(credential) == :no_password
    end

    test "a space-free nickserv password services would refuse is reported, with the reason",
         %{user: user, network: network} do
      credential = bind(user, network, String.duplicate("x", 33), :nickserv_identify)

      assert RepairPasswords.classify(credential) == {:report, {:unusable, :password_max_length}}
    end

    test "Azzurra's cap does not govern a SASL secret, so a long one stays healthy",
         %{user: user, network: network} do
      credential = bind(user, network, String.duplicate("x", 33), :sasl)

      assert RepairPasswords.classify(credential) == :healthy
    end

    test "two tokens whose repair services would still refuse are reported, not written",
         %{user: user, network: network} do
      credential = bind(user, network, "oldpass " <> String.duplicate("x", 33), :nickserv_identify)

      assert RepairPasswords.classify(credential) == {:report, {:unusable_repair, :password_max_length}}
    end
  end

  describe "run/1 — dry run is the default and writes nothing" do
    test "reports the candidate without touching it", %{user: user, network: network} do
      credential = bind(user, network, @two_token, :nickserv_identify)

      output = capture_io(fn -> RepairPasswords.run([]) end)

      assert output =~ "1 repairable"
      assert output =~ "DRY RUN"
      assert reload(credential).password_encrypted == @two_token
    end

    test "never prints the stored secret or either of its tokens", %{user: user, network: network} do
      _ = bind(user, network, @two_token, :nickserv_identify)

      output = capture_io(fn -> RepairPasswords.run([]) end)

      refute output =~ "oldpass"
      refute output =~ "newpass"
    end

    test "a healthy database reports zero candidates and stays silent about a new bug",
         %{user: user, network: network} do
      _ = bind(user, network, "hunter2000", :nickserv_identify)

      output = capture_io(fn -> RepairPasswords.run([]) end)

      assert output =~ "0 candidates"
      refute output =~ "NEW bug"
    end

    test "a candidate found after #124 is called out as the signal of a new bug",
         %{user: user, network: network} do
      _ = bind(user, network, @two_token, :nickserv_identify)

      output = capture_io(fn -> RepairPasswords.run([]) end)

      assert output =~ "NEW bug"
    end
  end

  describe "run/1 --write" do
    test "repairs a two-token nickserv credential to the last token", %{user: user, network: network} do
      credential = bind(user, network, @two_token, :nickserv_identify)

      capture_io(fn -> RepairPasswords.run(["--write"]) end)

      assert reload(credential).password_encrypted == "newpass"
    end

    test "leaves a SASL passphrase untouched", %{user: user, network: network} do
      credential = bind(user, network, @sasl_passphrase, :sasl)

      capture_io(fn -> RepairPasswords.run(["--write"]) end)

      assert reload(credential).password_encrypted == @sasl_passphrase
    end

    test "leaves a three-token credential untouched", %{user: user, network: network} do
      credential = bind(user, network, @three_token, :nickserv_identify)

      capture_io(fn -> RepairPasswords.run(["--write"]) end)

      assert reload(credential).password_encrypted == @three_token
    end

    test "never touches the retired nickserv_pass_encrypted column", %{user: user, network: network} do
      credential = bind(user, network, @two_token, :nickserv_identify)

      legacy = Grappa.Vault.encrypt!("legacy-secret")
      Repo.query!("UPDATE network_credentials SET nickserv_pass_encrypted = ? WHERE id = ?", [legacy, credential.id])

      capture_io(fn -> RepairPasswords.run(["--write"]) end)

      %{rows: [[after_run]]} =
        Repo.query!("SELECT nickserv_pass_encrypted FROM network_credentials WHERE id = ?", [credential.id])

      assert after_run == legacy
    end

    test "sweeps visitor credentials, not only user ones", %{network: network} do
      visitor = visitor_fixture(nick: "guest42", network_slug: "azzurra")
      {:ok, anon} = Credentials.get_visitor_credential(visitor.id, network.id)

      {:ok, credential} =
        anon
        |> Credential.password_changeset(@two_token)
        |> Ecto.Changeset.put_change(:auth_method, :nickserv_identify)
        |> Repo.update()

      capture_io(fn -> RepairPasswords.run(["--write"]) end)

      assert reload(credential).password_encrypted == "newpass"
    end

    test "is idempotent — a second pass finds nothing left to do", %{user: user, network: network} do
      _ = bind(user, network, @two_token, :nickserv_identify)

      capture_io(fn -> RepairPasswords.run(["--write"]) end)
      output = capture_io(fn -> RepairPasswords.run(["--write"]) end)

      assert output =~ "0 candidates"
    end
  end
end
