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

  @doc """
  Renders a changeset's errors as a `%{field => [message, ...]}` map,
  with `%{var}` interpolations resolved from the per-error opts list.

  Standard Phoenix-flavoured helper — lifted here so every DataCase user
  shares one copy instead of inlining a private clone per test file.
  """
  @spec errors_on(Ecto.Changeset.t()) :: %{atom() => [String.t()]}
  def errors_on(changeset) do
    Ecto.Changeset.traverse_errors(changeset, fn {message, opts} ->
      Regex.replace(~r"%{(\w+)}", message, fn _, key ->
        opts |> Keyword.get(String.to_existing_atom(key), key) |> to_string()
      end)
    end)
  end
end
