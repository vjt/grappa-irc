defmodule Grappa.Networks.CredentialTest do
  use Grappa.DataCase, async: true

  alias Grappa.Networks.Credential

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
