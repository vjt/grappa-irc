defmodule Grappa.MuteSession do
  @moduledoc """
  Registers a process in `Grappa.SessionRegistry` under a real session
  key that accepts every `GenServer.call` into its mailbox and answers
  NONE of them — the deterministic stand-in for a `Session.Server`
  whose mailbox is too deep (or whose current callback is parked on a
  DB connection) to reply inside a caller's receive budget.

  ## Why a whole helper and not `IRCServer` (issue 2239)

  `Grappa.IRCServer` gives tests a session that is *alive but idle* —
  which is the opposite axis. Nothing in the suite could produce the
  one state that makes `Grappa.Session`'s `call_session/4` take its
  `:exit, {:timeout, _}` branch, so `{:error, :timeout}` was a
  reachable return that no test had ever observed and no caller had
  ever been asked to handle.

  A caller's budget is what it is: `Session.list_channels/2` spends the
  `call_session/3` default of 5s, so a test that drives it through this
  helper pays that wall-clock. Reach for the explicit-timeout variant
  (`list_channels/3`, 250 ms in `Grappa.LiveIntrospection`) where the
  function under test offers one.

  ## Lifecycle

  `register!/2` blocks until the registration is visible to
  `Grappa.Session.whereis/2`, so the caller never races it, and
  installs an `on_exit` that kills the process — the registry entry
  goes with it. Must be called from the test process (it uses
  `ExUnit.Callbacks.on_exit/1`).
  """

  use Boundary, top_level?: true, deps: [Grappa.Session]

  alias Grappa.Session

  @doc """
  Occupies `(subject, network_id)`'s registry slot with a process that
  never replies. Returns its pid.

  Raises if the slot is already taken — a real `Session.Server` there
  would make the test silently measure something else.
  """
  @spec register!(Session.subject(), integer()) :: pid()
  def register!(subject, network_id) when is_integer(network_id) do
    test_pid = self()
    key = Session.registry_key(subject, network_id)

    pid =
      spawn(fn ->
        case Registry.register(Grappa.SessionRegistry, key, nil) do
          {:ok, _} -> send(test_pid, {:mute_session_registered, self()})
          {:error, reason} -> send(test_pid, {:mute_session_failed, reason})
        end

        # Never reply, never exit on our own: the caller's receive budget
        # is the only clock in the test. Killed by the on_exit below.
        Process.sleep(:infinity)
      end)

    receive do
      {:mute_session_registered, ^pid} -> :ok
      {:mute_session_failed, reason} -> raise "session slot #{inspect(key)} taken: #{inspect(reason)}"
    after
      1_000 -> raise "mute session did not register under #{inspect(key)} within 1s"
    end

    ExUnit.Callbacks.on_exit(fn -> Process.exit(pid, :kill) end)

    pid
  end
end
