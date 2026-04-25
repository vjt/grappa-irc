defmodule GrappaWeb.ConnCase do
  @moduledoc """
  Conn-test base case for the Phoenix surface.

  Mirrors `Grappa.DataCase` but adds the connection helpers from
  `Phoenix.ConnTest` so controller and channel tests share one entry point.
  Sandbox ownership is per-test to keep `async: true` viable; non-async
  cases fall back to shared mode automatically.
  """

  use ExUnit.CaseTemplate

  using do
    quote do
      import Plug.Conn
      import Phoenix.ConnTest

      @endpoint GrappaWeb.Endpoint
    end
  end

  setup tags do
    pid = Ecto.Adapters.SQL.Sandbox.start_owner!(Grappa.Repo, shared: not tags[:async])
    on_exit(fn -> Ecto.Adapters.SQL.Sandbox.stop_owner(pid) end)
    {:ok, conn: Phoenix.ConnTest.build_conn()}
  end
end
