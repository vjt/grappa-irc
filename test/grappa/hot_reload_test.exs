defmodule Grappa.HotReloadTest do
  # async: false — mutates global BEAM code-server state (load_binary,
  # purge) for synthetic modules. Each test uses its own uniquely-named
  # module so tests can't collide, but the code server is a singleton.
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

  defp tmp_ebin(tag) do
    tmp = Path.join(System.tmp_dir!(), "hot_reload_#{tag}_#{System.unique_integer([:positive])}")
    File.mkdir_p!(tmp)
    on_exit(fn -> File.rm_rf!(tmp) end)
    tmp
  end

  defp write_beam!(dir, mod, bin), do: File.write!(Path.join(dir, "#{mod}.beam"), bin)

  # The live-repro shape (2026-06-10, prod): a module hot-reloaded once
  # already carries old+current versions; without a soft-purge the
  # SECOND reload fails {:error, :not_purged}. reload_from/1 must
  # soft-purge first so repeated hot deploys of the same module succeed.
  test "reloads a module that already has old code (the double-hot-deploy :not_purged repro)" do
    mod = HotReloadTestDoubleReload
    tmp = tmp_ebin("double")

    src = fn version ->
      "defmodule #{inspect(mod)} do\n  def version, do: #{version}\nend\n"
    end

    # Compile all three versions BEFORE any explicit loading (each
    # compile loads as a side effect), then reset to a clean slate.
    bin1 = compile_quietly(mod, src.(1))
    bin2 = compile_quietly(mod, src.(2))
    bin3 = compile_quietly(mod, src.(3))
    reset_code_server(mod)
    on_exit(fn -> reset_code_server(mod) end)

    # v3 on disk — what reload_from/1 should end up loading.
    write_beam!(tmp, mod, bin3)

    # v1 loaded, then v2 loaded → v1 becomes old code, v2 current.
    {:module, ^mod} = :code.load_binary(mod, ~c"#{mod}.beam", bin1)
    {:module, ^mod} = :code.load_binary(mod, ~c"#{mod}.beam", bin2)
    assert apply(mod, :version, []) == 2

    assert %{reloaded: [^mod], failed: []} = HotReload.reload_from(tmp)
    assert apply(mod, :version, []) == 3
  end

  test "refuses (does not kill) when a process still runs old code — honest :old_code_in_use failure" do
    mod = HotReloadTestHeldCode
    tmp = tmp_ebin("held")

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

    # Compile all versions first (compile loads as a side effect),
    # then reset and drive loads explicitly.
    bin1 = compile_quietly(mod, src.(1))
    bin2 = compile_quietly(mod, src.(2))
    bin3 = compile_quietly(mod, src.(3))
    reset_code_server(mod)

    write_beam!(tmp, mod, bin3)

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
    assert %{reloaded: [], failed: [{^mod, :old_code_in_use}]} = HotReload.reload_from(tmp)
    assert Process.alive?(holder)
  end

  # The third live repro of 2026-06-10: a hot deploy that ADDS a new
  # module is invisible to :code.modified_modules/0, and the release's
  # cached code path (OTP 26+) makes the new beam :nofile for plain
  # :code.load_file/1 — the first call into the new module 500s with
  # :undef (embedded mode never lazy-loads). reload_from/1 discovers
  # and load_abs's it.
  test "loads a never-loaded beam (new-module hot deploy)" do
    mod = HotReloadTestBrandNew
    tmp = tmp_ebin("new")

    bin = compile_quietly(mod, "defmodule #{inspect(mod)} do\n  def version, do: 7\nend\n")
    # compile_quietly loaded it as a side effect — unload so the module
    # is genuinely "brand new" to the code server.
    reset_code_server(mod)
    on_exit(fn -> reset_code_server(mod) end)
    write_beam!(tmp, mod, bin)

    refute :code.is_loaded(mod)
    assert %{reloaded: [^mod], failed: []} = HotReload.reload_from(tmp)
    assert apply(mod, :version, []) == 7
  end

  test "skips a loaded module whose on-disk beam is byte-identical (md5 match)" do
    mod = HotReloadTestUnchanged
    tmp = tmp_ebin("skip")

    bin = compile_quietly(mod, "defmodule #{inspect(mod)} do\n  def version, do: 1\nend\n")
    # Leave it loaded (compile side effect); same bytes on disk.
    on_exit(fn -> reset_code_server(mod) end)
    write_beam!(tmp, mod, bin)

    assert %{reloaded: [], failed: []} = HotReload.reload_from(tmp)
  end

  test "empty ebin dir → nothing reloaded, nothing failed" do
    assert %{reloaded: [], failed: []} = HotReload.reload_from(tmp_ebin("empty"))
  end

  # NO test calls reload_modified/0: under `mix coveralls` the loaded
  # code is cover-instrumented, so its md5 NEVER matches the disk
  # beams — walking the real app ebin from a test would "reload"
  # (de-instrument) every module mid-run and corrupt coverage. The
  # composition is a one-liner over reload_from/1, which is fully
  # covered above.
end
