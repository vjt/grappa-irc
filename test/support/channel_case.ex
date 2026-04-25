defmodule GrappaWeb.ChannelCase do
  @moduledoc """
  Test case template for `Phoenix.Channel` tests.

  Imports `Phoenix.ChannelTest` (`socket/3`, `subscribe_and_join/3`,
  `assert_push/3`, `refute_push/3`, `push/3`) and pins `@endpoint` so
  the helpers can resolve the right Endpoint for socket assembly.

  Sets up `Ecto.Adapters.SQL.Sandbox` per test the same way
  `Grappa.DataCase` does — channel tests that subscribe to PubSub may
  observe broadcasts from controller actions running in the same
  process, so the sandbox must allow shared mode when `async: false`.
  """
  use ExUnit.CaseTemplate

  using do
    quote do
      import Phoenix.ChannelTest
      import GrappaWeb.ChannelCase

      @endpoint GrappaWeb.Endpoint
    end
  end

  setup tags do
    pid = Ecto.Adapters.SQL.Sandbox.start_owner!(Grappa.Repo, shared: not tags[:async])
    on_exit(fn -> Ecto.Adapters.SQL.Sandbox.stop_owner(pid) end)
    :ok
  end
end
