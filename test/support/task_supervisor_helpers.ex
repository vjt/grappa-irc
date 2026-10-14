defmodule Grappa.TaskSupervisorHelpers do
  @moduledoc """
  Test-only drain for detached `Grappa.TaskSupervisor` work.

  Several doors hand DB work to a supervised fire-and-forget task (the
  read-cursor fanout, #273; the socket client-source capture, #1618; the
  own-send cursor advance, issue 2407). A test that does not wait for that
  task lets it outlive the case and hit `stop_owner`, or the NEXT case,
  with a query in flight on the shared sandbox connection. Registered as an
  `on_exit` AFTER the case template's sandbox owner (on_exit is LIFO), the
  drain runs first.

  `Task.Supervisor.children/1` is GLOBAL, so a caller must be `async:
  false`: that is what makes the only live children its own.
  """
  use Boundary, top_level?: true, deps: []

  @doc """
  Waits, at most 2s per child, for every live `Grappa.TaskSupervisor`
  child to exit.
  """
  @spec drain_children() :: :ok
  def drain_children do
    Grappa.TaskSupervisor
    |> Task.Supervisor.children()
    |> Enum.each(fn pid ->
      ref = Process.monitor(pid)

      receive do
        {:DOWN, ^ref, :process, ^pid, _} -> :ok
      after
        2_000 -> Process.demonitor(ref, [:flush])
      end
    end)
  end
end
