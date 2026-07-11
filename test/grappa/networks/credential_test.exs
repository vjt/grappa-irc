defmodule Grappa.Networks.CredentialTest do
  use Grappa.DataCase, async: true

  alias Grappa.Networks.Credential

  describe "ident field (#152)" do
    defp base_attrs(extra) do
      Map.merge(
        %{user_id: Ecto.UUID.generate(), network_id: 1, nick: "vjt", auth_method: :none},
        extra
      )
    end

    test "effective_ident/1 falls back to nick when ident is nil" do
      assert Credential.effective_ident(%Credential{ident: nil, nick: "vjt"}) == "vjt"
    end

    test "effective_ident/1 returns the ident when set" do
      assert Credential.effective_ident(%Credential{ident: "grp", nick: "vjt"}) == "grp"
    end

    test "changeset casts a valid ident" do
      cs = Credential.changeset(%Credential{}, base_attrs(%{ident: "grp_1"}))
      assert cs.valid?
      assert Ecto.Changeset.get_change(cs, :ident) == "grp_1"
    end

    test "changeset strips a leading tilde before validating (anti-spoof)" do
      cs = Credential.changeset(%Credential{}, base_attrs(%{ident: "~grp"}))
      assert cs.valid?
      assert Ecto.Changeset.get_change(cs, :ident) == "grp"
    end

    test "changeset rejects an ident over 10 chars" do
      cs = Credential.changeset(%Credential{}, base_attrs(%{ident: String.duplicate("a", 11)}))
      refute cs.valid?
      assert "must be a valid IRC ident" in errors_on(cs).ident
    end

    test "changeset rejects an ident with @ or whitespace" do
      assert "must be a valid IRC ident" in errors_on(Credential.changeset(%Credential{}, base_attrs(%{ident: "a@b"}))).ident

      assert "must be a valid IRC ident" in errors_on(Credential.changeset(%Credential{}, base_attrs(%{ident: "a b"}))).ident
    end

    test "changeset rejects a residual tilde (~~evil sanitizes to ~evil, still invalid)" do
      cs = Credential.changeset(%Credential{}, base_attrs(%{ident: "~~evil"}))
      refute cs.valid?
      assert "must be a valid IRC ident" in errors_on(cs).ident
    end

    test "ident is optional (nil passes)" do
      assert Credential.changeset(%Credential{}, base_attrs(%{})).valid?
    end
  end

  describe "connection_state field (T32)" do
    test "round-trips :connected | :parked | :failed via changeset" do
      # `get_field` (not `get_change`) — `:connected` is the schema
      # default, so casting it is a no-op and `get_change` would
      # return nil for that case while `get_field` reflects the
      # effective value (default-merged).
      for state <- [:connected, :parked, :failed] do
        cs =
          Credential.changeset(%Credential{}, %{
            user_id: Ecto.UUID.generate(),
            network_id: 1,
            nick: "vjt",
            auth_method: :none,
            connection_state: state
          })

        assert Ecto.Changeset.get_field(cs, :connection_state) == state
      end
    end

    test "rejects unknown atoms at Ecto.Enum boundary" do
      cs =
        Credential.changeset(%Credential{}, %{
          user_id: Ecto.UUID.generate(),
          network_id: 1,
          nick: "vjt",
          auth_method: :none,
          connection_state: :bogus
        })

      refute cs.valid?
      assert "is invalid" in errors_on(cs).connection_state
    end

    test "connection_state_reason accepts a free-form string" do
      cs =
        Credential.changeset(%Credential{}, %{
          user_id: Ecto.UUID.generate(),
          network_id: 1,
          nick: "vjt",
          auth_method: :none,
          connection_state: :failed,
          connection_state_reason: "k-line: G:Lined (host eviction)"
        })

      assert Ecto.Changeset.get_change(cs, :connection_state_reason) ==
               "k-line: G:Lined (host eviction)"
    end

    test "connection_state_changed_at accepts a UTC datetime" do
      ts = ~U[2026-05-04 12:34:56Z]

      cs =
        Credential.changeset(%Credential{}, %{
          user_id: Ecto.UUID.generate(),
          network_id: 1,
          nick: "vjt",
          auth_method: :none,
          connection_state: :parked,
          connection_state_changed_at: ts
        })

      assert Ecto.Changeset.get_change(cs, :connection_state_changed_at) == ts
    end
  end
end
