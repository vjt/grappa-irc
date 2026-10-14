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
  Waits until no `Grappa.TaskSupervisor` child is left alive, giving each
  child at most 2s.

  One snapshot is not enough: a child can start another while it runs (the
  own-send advance spawns its fan-out only after its write lands), and a
  child born after the snapshot would outlive the case. So the children are
  re-read until none is alive. A child that outlives its 2s is given up on and
  never waited for again, so a stuck one cannot keep the loop going.
  """
  @spec drain_children() :: :ok
  def drain_children, do: drain([])

  @spec drain([pid()]) :: :ok
  defp drain(given_up) do
    case Task.Supervisor.children(Grappa.TaskSupervisor) -- given_up do
      [] -> :ok
      pids -> pids |> Enum.reduce(given_up, &await_exit/2) |> drain()
    end
  end

  @spec await_exit(pid(), [pid()]) :: [pid()]
  defp await_exit(pid, given_up) do
    ref = Process.monitor(pid)

    receive do
      {:DOWN, ^ref, :process, ^pid, _} -> given_up
    after
      2_000 ->
        Process.demonitor(ref, [:flush])
        [pid | given_up]
    end
  end
end
