defmodule Grappa.HotReloadTest do
  # async: false — mutates global BEAM code-server state (load_binary,
  # add_patha, purge) for synthetic modules. Each test uses its own
  # uniquely-named module so tests can't collide, but the code server
  # itself is a singleton.
  use ExUnit.Case, async: false

  alias Grappa.HotReload

  # Compile `source` → beam binary. NOTE: Code.compile_string LOADS
  # the module as a side effect, so callers must compile every version
  # FIRST, then `reset_code_server/1`, then drive :code.load_binary
  # explicitly — otherwise each compile shifts the current/old slots
  # behind the test's back.
  defp compile_quietly(mod, source) do
    Code.put_compiler_option(:ignore_module_conflict, true)

    try do
      [{^mod, bin}] = Code.compile_string(source)
      bin
    after
      Code.put_compiler_option(:ignore_module_conflict, false)
    end
  end

  # Remove BOTH version slots of `mod` from the code server.
  defp reset_code_server(mod) do
    :code.purge(mod)
    :code.delete(mod)
    :code.purge(mod)
  end

  # The live-repro shape (2026-06-10, prod): a module hot-reloaded once
  # already carries old+current versions; a bare :code.load_file/1 for
  # the SECOND reload returns {:error, :not_purged}. reload_modules/1
  # must soft-purge first so repeated hot deploys of the same module
  # succeed.
  test "reloads a module that already has old code (the double-hot-deploy :not_purged repro)" do
    mod = HotReloadTestDoubleReload
    tmp = Path.join(System.tmp_dir!(), "hot_reload_test_#{System.unique_integer([:positive])}")
    File.mkdir_p!(tmp)
    on_exit(fn -> File.rm_rf!(tmp) end)

    src = fn version ->
      "defmodule #{inspect(mod)} do\n  def version, do: #{version}\nend\n"
    end

    # Compile all three versions BEFORE any explicit loading (each
    # compile loads as a side effect), then reset to a clean slate.
    bin1 = compile_quietly(mod, src.(1))
    bin2 = compile_quietly(mod, src.(2))
    bin3 = compile_quietly(mod, src.(3))
    reset_code_server(mod)

    # v3 on disk — what reload_modules/1 should end up loading.
    File.write!(Path.join(tmp, "#{mod}.beam"), bin3)
    true = :code.add_patha(String.to_charlist(tmp))

    on_exit(fn ->
      :code.del_path(String.to_charlist(tmp))
      reset_code_server(mod)
    end)

    # v1 loaded, then v2 loaded → v1 becomes old code, v2 current.
    {:module, ^mod} = :code.load_binary(mod, ~c"#{mod}.beam", bin1)
    {:module, ^mod} = :code.load_binary(mod, ~c"#{mod}.beam", bin2)
    assert apply(mod, :version, []) == 2

    # Direct load_file now fails — this is the prod incident shape.
    assert {:error, :not_purged} = :code.load_file(mod)

    assert %{reloaded: [^mod], failed: []} = HotReload.reload_modules([mod])
    assert apply(mod, :version, []) == 3
  end

  test "refuses (does not kill) when a process still runs old code — honest :old_code_in_use failure" do
    mod = HotReloadTestHeldCode

    src = fn version ->
      """
      defmodule #{inspect(mod)} do
        def version, do: #{version}
        def loop(parent) do
          send(parent, {:in_loop, self()})
          receive do
            :stop -> :ok
          end
        end
      end
      """
    end

    # Compile both versions first (compile loads as a side effect),
    # then reset and drive loads explicitly.
    bin1 = compile_quietly(mod, src.(1))
    bin2 = compile_quietly(mod, src.(2))
    reset_code_server(mod)

    {:module, ^mod} = :code.load_binary(mod, ~c"#{mod}.beam", bin1)

    # This process executes v1's loop/1 and never returns — it HOLDS
    # the v1 code. The :in_loop message is sent from INSIDE v1's body,
    # so receiving it proves the process entered v1 before v2 loads
    # (without it, spawn racing the next load_binary makes the holder
    # resolve loop/1 to v2 and the test asserts nothing).
    parent = self()
    holder = spawn(fn -> apply(mod, :loop, [parent]) end)
    assert_receive {:in_loop, ^holder}, 1_000

    on_exit(fn ->
      if Process.alive?(holder), do: Process.exit(holder, :kill)
      reset_code_server(mod)
    end)

    # v2 load → v1 becomes old code, still held by `holder`.
    {:module, ^mod} = :code.load_binary(mod, ~c"#{mod}.beam", bin2)

    # soft_purge must refuse (killing `holder` would be a session drop
    # in prod), and the failure must be surfaced, not swallowed.
    assert %{reloaded: [], failed: [{^mod, :old_code_in_use}]} =
             HotReload.reload_modules([mod])

    assert Process.alive?(holder)
  end

  test "empty module list → nothing reloaded, nothing failed" do
    assert %{reloaded: [], failed: []} = HotReload.reload_modules([])
  end

  test "reload_modified/0 returns the same shape (zero modified modules in a test run)" do
    # In a test run nothing recompiles beams behind the code server's
    # back, so modified_modules is empty — this pins the wiring and
    # the shape, not the walk.
    assert %{reloaded: reloaded, failed: failed} = HotReload.reload_modified()
    assert is_list(reloaded)
    assert is_list(failed)
  end
end
