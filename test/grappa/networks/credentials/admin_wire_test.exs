defmodule Grappa.Networks.Credentials.AdminWireTest do
  @moduledoc """
  Pure projection tests for `Networks.Credentials.AdminWire`.
  Constructs `%Credential{}` literals with `password_encrypted` +
  virtual `password` populated so the credential-material absence
  assertion has bite (the post-Cloak-load value IS the plaintext IRC
  password; this test pins the defensive allowlist).
  """
  use ExUnit.Case, async: true

  alias Grappa.LiveIntrospection.SessionEntry
  alias Grappa.Networks.{Credential, Network}
  alias Grappa.Networks.Credentials.AdminWire

  defp credential_fixture do
    now = DateTime.utc_now()

    %Credential{
      user_id: "11111111-1111-1111-1111-111111111111",
      network_id: 42,
      network: %Network{id: 42, slug: "azzurra"},
      nick: "vjt",
      ident: "grp",
      realname: "Real Name",
      sasl_user: "vjt-sasl",
      password_encrypted: "decrypted-plaintext-MUST-NEVER-LEAK",
      password: "input-virtual-MUST-NEVER-LEAK",
      auth_method: :sasl,
      auth_command_template: nil,
      autojoin_channels: ["#sbiffo"],
      last_joined_channels: ["#sbiffo", "#bofh"],
      connection_state: :connected,
      connection_state_reason: nil,
      connection_state_changed_at: now,
      inserted_at: now,
      updated_at: now
    }
  end

  describe "credential_to_admin_json/2" do
    test "projects operator-relevant fields + nil live_state when no session" do
      now = DateTime.utc_now()
      c = %{credential_fixture() | inserted_at: now, updated_at: now}

      assert %{
               user_id: "11111111-1111-1111-1111-111111111111",
               network_id: 42,
               network_slug: "azzurra",
               nick: "vjt",
               ident: "grp",
               realname: "Real Name",
               sasl_user: "vjt-sasl",
               auth_method: :sasl,
               autojoin_channels: ["#sbiffo"],
               last_joined_channels: ["#sbiffo", "#bofh"],
               connection_state: :connected,
               inserted_at: ^now,
               updated_at: ^now,
               live_state: nil
             } = AdminWire.credential_to_admin_json(c, nil)
    end

    test "projects live_state when a SessionEntry is supplied" do
      c = credential_fixture()
      pid = self()

      entry = %SessionEntry{
        subject: {:user, c.user_id},
        network_id: c.network_id,
        pid: pid,
        alive: true,
        mailbox_len: 0,
        memory_bytes: 12_345,
        joined_channels: ["#bofh"],
        introspection_degraded: []
      }

      assert %{
               live_state: %{
                 alive: true,
                 pid_inspect: pid_str,
                 mailbox_len: 0,
                 memory_bytes: 12_345,
                 joined_channels: ["#bofh"],
                 introspection_degraded: []
               }
             } = AdminWire.credential_to_admin_json(c, entry)

      assert is_binary(pid_str)
      assert String.starts_with?(pid_str, "#PID<")
    end

    test "NEVER includes password_encrypted or password (credential material exclusion)" do
      json = AdminWire.credential_to_admin_json(credential_fixture(), nil)

      refute Map.has_key?(json, :password)
      refute Map.has_key?(json, :password_encrypted)

      refute Enum.any?(json, fn {_, v} ->
               is_binary(v) and String.contains?(v, "MUST-NEVER-LEAK")
             end)
    end
  end
end
