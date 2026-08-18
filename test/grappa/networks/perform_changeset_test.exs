defmodule Grappa.Networks.PerformChangesetTest do
  @moduledoc """
  #189 — the on-connect perform list + `$oper_pass` secret live on the
  credential, encrypted at rest (Cloak AES-GCM, `EncryptedBinary
  redact: true`) exactly like `password_encrypted`. `perform_changeset/2`
  is the narrow write path the per-network REST editor drives; it casts
  the two virtual inputs, encrypts them, and touches nothing else (mirror
  of `password_changeset/2` / `last_joined_channels_changeset/2`).

  Async-safe: each test sets up a unique user/network pair via fixtures.
  """
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Networks.Credential
  alias Grappa.Repo

  defp rotating_credential(attrs) do
    user_with_credential(
      6667,
      Map.merge(%{auth_method: :nickserv_identify, password: "oldpass"}, attrs)
    )
  end

  describe "Credential.perform_changeset/2" do
    test "encrypts + round-trips perform_list and oper_pass on read (Cloak decrypt)" do
      {_, _, cred} = rotating_credential(%{})

      cs =
        Credential.perform_changeset(cred, %{
          perform_list: "NS IDENTIFY $nickserv_pass\nOPER vjt $oper_pass",
          oper_pass: "hunter2"
        })

      assert cs.valid?
      {:ok, saved} = Repo.update(cs)
      reloaded = reload_credential(saved)

      # After Cloak :load, the *_encrypted fields carry the DECRYPTED plaintext.
      assert reloaded.perform_list_encrypted ==
               "NS IDENTIFY $nickserv_pass\nOPER vjt $oper_pass"

      assert reloaded.oper_pass_encrypted == "hunter2"
    end

    test "accessors return the decrypted plaintext, nil when unset" do
      {_, _, cred} = rotating_credential(%{})

      {:ok, saved} =
        cred
        |> Credential.perform_changeset(%{
          perform_list: "MODE $nick +x",
          oper_pass: "s3cr3t"
        })
        |> Repo.update()

      reloaded = reload_credential(saved)
      assert Credential.perform_list_text(reloaded) == "MODE $nick +x"
      assert Credential.upstream_oper_pass(reloaded) == "s3cr3t"

      {_, _, bare} = rotating_credential(%{})
      assert Credential.perform_list_text(bare) == nil
      assert Credential.upstream_oper_pass(bare) == nil
    end

    test "inspect/1 never leaks perform_list or oper_pass (redact: true)" do
      {_, _, cred} = rotating_credential(%{})

      {:ok, saved} =
        cred
        |> Credential.perform_changeset(%{
          perform_list: "OPER vjt topsecret",
          oper_pass: "leakme"
        })
        |> Repo.update()

      dump = inspect(reload_credential(saved))
      refute dump =~ "topsecret"
      refute dump =~ "leakme"
    end

    test "a multi-line perform list is accepted (newlines are the line separator)" do
      {_, _, cred} = rotating_credential(%{})

      cs =
        Credential.perform_changeset(cred, %{
          perform_list: "# comment\nNS IDENTIFY $nickserv_pass\n\nMODE $nick +x\n"
        })

      assert cs.valid?
    end

    test "clearing perform_list / oper_pass with empty string stores nil" do
      {_, _, cred} = rotating_credential(%{})

      {:ok, saved} =
        cred
        |> Credential.perform_changeset(%{
          perform_list: "MODE $nick +x",
          oper_pass: "x"
        })
        |> Repo.update()

      {:ok, cleared} =
        saved
        |> Credential.perform_changeset(%{perform_list: "", oper_pass: ""})
        |> Repo.update()

      reloaded = reload_credential(cleared)
      assert Credential.perform_list_text(reloaded) == nil
      assert Credential.upstream_oper_pass(reloaded) == nil
    end

    test "omitting oper_pass keeps the stored secret (leave-blank-to-keep)" do
      {_, _, cred} = rotating_credential(%{})

      {:ok, saved} =
        cred
        |> Credential.perform_changeset(%{oper_pass: "keepme"})
        |> Repo.update()

      # A later edit that touches ONLY the perform list must not disturb the
      # stored oper secret (get_change == nil → keep-branch).
      {:ok, updated} =
        saved
        |> Credential.perform_changeset(%{perform_list: "MODE $nick +x"})
        |> Repo.update()

      reloaded = reload_credential(updated)
      assert Credential.perform_list_text(reloaded) == "MODE $nick +x"
      assert Credential.upstream_oper_pass(reloaded) == "keepme"
    end

    test "rejects a NUL byte in perform_list" do
      {_, _, cred} = rotating_credential(%{})
      cs = Credential.perform_changeset(cred, %{perform_list: "MODE $nick +x\0evil"})
      refute cs.valid?
      assert %{perform_list: [_ | _]} = errors_on(cs)
    end

    test "rejects CR/LF/NUL in oper_pass (single-line secret)" do
      {_, _, cred} = rotating_credential(%{})
      cs = Credential.perform_changeset(cred, %{oper_pass: "bad\r\npass"})
      refute cs.valid?
      assert %{oper_pass: [_ | _]} = errors_on(cs)
    end

    # #124's twin of this test staged a `nickserv_pass` attr and proved it
    # could not reach the retired column. #1044 DROPPED that column, so the
    # attr no longer names a field anywhere and the write it guarded against
    # has no destination left. What replaces it is the same guard aimed at the
    # column #1044 reopened, which DOES have a live write path.
    test "#1044 — the perform door cannot reach the server-PASS slot" do
      # The slot is an AUTH field: it is written through the wide changeset, on
      # the user branch only. The perform editor is a different door and must
      # stay unable to write it — otherwise a secret gets a second editable
      # home, which is the split brain #124 is named after.
      {_, _, cred} = rotating_credential(%{})

      {:ok, saved} =
        cred
        |> Credential.perform_changeset(%{perform_list: "MODE $nick +x", server_pass: "sneaky"})
        |> Repo.update()

      assert reload_credential(saved).server_pass_encrypted == nil
    end

    test "rejects a perform list over the byte cap" do
      {_, _, cred} = rotating_credential(%{})
      huge = String.duplicate("MODE $nick +x\n", 2000)
      cs = Credential.perform_changeset(cred, %{perform_list: huge})
      refute cs.valid?
      assert %{perform_list: [_ | _]} = errors_on(cs)
    end
  end
end
