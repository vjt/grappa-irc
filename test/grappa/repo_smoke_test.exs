defmodule Grappa.RepoSmokeTest do
  @moduledoc """
  Smoke test that the Repo + sandbox + migration are wired correctly.

  Asserts a round-trip insert/fetch via the Message schema. If this
  passes, Task 2's infra (Repo, DataCase, sandbox, migration, schema)
  is functional. Domain-level scrollback queries land in Task 3.
  """
  use Grappa.DataCase, async: true

  alias Grappa.Repo
  alias Grappa.Scrollback.Message

  test "Repo round-trips a Message through the sandbox" do
    attrs = %{
      network_id: "azzurra",
      channel: "#sniffo",
      server_time: 1_777_804_800_000,
      kind: :privmsg,
      sender: "vjt",
      body: "ciao"
    }

    assert {:ok, %Message{id: id, kind: :privmsg}} =
             %Message{}
             |> Message.changeset(attrs)
             |> Repo.insert()

    assert %Message{kind: :privmsg, sender: "vjt", body: "ciao"} = Repo.get!(Message, id)
  end
end
