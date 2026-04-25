defmodule Grappa.DataCase do
  @moduledoc """
  Test case template for tests that touch the Repo.

  Sets up an `Ecto.Adapters.SQL.Sandbox` checkout per test. Use
  `async: true` (the default) — sqlite serializes writes at the DB
  level but each test's transaction is isolated and rolled back on exit.

  `use Grappa.DataCase, async: true` is the canonical opening line.
  """
  use ExUnit.CaseTemplate

  using do
    quote do
      alias Grappa.Repo

      import Ecto
      import Ecto.{Changeset, Query}
      import Grappa.DataCase
    end
  end

  setup tags do
    pid = Ecto.Adapters.SQL.Sandbox.start_owner!(Grappa.Repo, shared: not tags[:async])
    on_exit(fn -> Ecto.Adapters.SQL.Sandbox.stop_owner(pid) end)
    :ok
  end
end
