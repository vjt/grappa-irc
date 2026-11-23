defmodule Grappa.AdmissionStateHelpersTest do
  @moduledoc """
  Loudness pin for `clear_registry_for!/2` (#1397 bucket H).

  The two per-test-file `clear_registry_for/1` copies this helper
  replaces failed OPEN: their last clause was
  `defp wait_until_registry_clear(_, 0), do: :ok`, so once the 500ms
  budget expired they returned `:ok` with zombies still registered and
  the test carried on against a dirty registry. That is the failure
  mode `AdmissionStateHelpers`' own moduledoc already names, and it is
  what makes a cap assertion fail somewhere else entirely.

  De-duplication alone is preserving by construction, so it cannot
  witness that the barrier stopped failing open. This test is that
  witness: it holds a registered pid the purge cannot remove and pins
  that the helper RAISES rather than returning `:ok`.
  """
  use ExUnit.Case, async: false

  alias Grappa.{AdmissionStateHelpers, Session}

  # Small budget: the test's subject is the raise, not the wait. The
  # value is passed at the call site precisely so a test can be cheap
  # while the suite's real callers stay patient.
  @budget_ms 50

  describe "clear_registry_for!/2" do
    test "raises when a registered session survives the purge" do
      network_id = System.unique_integer([:positive])
      _key = register_unkillable_session(network_id)

      assert_raise RuntimeError, ~r/still has 1 session.*network_id=#{network_id}/, fn ->
        AdmissionStateHelpers.clear_registry_for!(network_id, @budget_ms)
      end
    end

    test "returns :ok when nothing is registered for the network" do
      assert :ok = AdmissionStateHelpers.clear_registry_for!(System.unique_integer([:positive]), @budget_ms)
    end

    test "leaves another network's session registered" do
      mine = System.unique_integer([:positive])
      theirs = System.unique_integer([:positive])
      key = register_unkillable_session(theirs)

      assert :ok = AdmissionStateHelpers.clear_registry_for!(mine, @budget_ms)
      assert [_] = Registry.lookup(Grappa.SessionRegistry, key)
    end
  end

  # A plain process registered under a session key: it is not a
  # `SessionSupervisor` child, so `terminate_child/2` cannot reach it,
  # and it is not an OTP process, so the `GenServer.stop` sweep times
  # out on it. Exactly the zombie shape the 500ms copies gave up on.
  # Registered under `Session.registry_key/2` (issue 2696), so the helper
  # must SEE it: with a literal key, a key change left the helper and this
  # test agreeing with each other and blind to every real session.
  #
  # Cleanup is an `on_exit`, never a line after the assert: a failed
  # assert ends the test before that line, and this process is unlinked
  # and sleeps forever, so it stays registered. Every later `reset_all/0`
  # in the suite then raises after its 15 s wait (issue 2696, measured:
  # the desync mutant's one red here became 143 reds in 5 other modules
  # before the run was stopped at 6389 of 8981 tests).
  defp register_unkillable_session(network_id) do
    key = Session.registry_key({:user, Ecto.UUID.generate()}, network_id)
    parent = self()

    pid =
      spawn(fn ->
        {:ok, _} = Registry.register(Grappa.SessionRegistry, key, nil)
        send(parent, :registered)
        Process.sleep(:infinity)
      end)

    assert_receive :registered, 1_000
    on_exit(fn -> unregister(pid, key) end)
    key
  end

  defp unregister(pid, key) do
    Process.exit(pid, :kill)

    Enum.reduce_while(1..100, :waiting, fn _, _ ->
      case Registry.lookup(Grappa.SessionRegistry, key) do
        [] -> {:halt, :ok}
        _ -> Process.sleep(5) && {:cont, :waiting}
      end
    end)
  end
end
