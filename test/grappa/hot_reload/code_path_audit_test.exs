defmodule Grappa.HotReload.CodePathAuditTest do
  # Pure filesystem inspection — no code-server mutation, no repo.
  use ExUnit.Case, async: true

  alias Grappa.HotReload

  # ---- fixtures -------------------------------------------------------
  #
  # Both shapes are transcribed from a MEASURED `mix release --overwrite`
  # run (2026-09-06, isolated build cache), not invented: a release rooted
  # at `<rel>` carries `<rel>/lib/grappa-<vsn>/ebin` plus
  # `<rel>/releases/start_erl.data` holding `"<erts_vsn> <release_vsn>"`.
  # The bind-mounted Docker tree carries neither the vsn in the path nor a
  # `releases/` dir at all.

  defp tmp_root(tag) do
    root = Path.join(System.tmp_dir!(), "code_path_#{tag}_#{System.unique_integer([:positive])}")
    File.mkdir_p!(root)
    on_exit(fn -> File.rm_rf!(root) end)
    root
  end

  # A `mix release` tree: one lib dir per `vsn` in `lib_vsns`, and a
  # start_erl.data naming `built`. Returns the release root.
  defp release_tree!(root, lib_vsns, built) do
    Enum.each(lib_vsns, &File.mkdir_p!(Path.join([root, "lib", "grappa-#{&1}", "ebin"])))
    File.mkdir_p!(Path.join(root, "releases"))

    if built do
      File.write!(Path.join([root, "releases", "start_erl.data"]), "16.4.0.4 #{built}\n")
    end

    root
  end

  defp lib_dir(root, vsn), do: Path.join([root, "lib", "grappa-#{vsn}"])

  # ---- negative controls: the audit MUST stay silent -------------------

  test "Docker's unversioned bind-mounted layout is inert — no vsn in the lib path" do
    root = tmp_root("docker")
    # `/app/_build/<env>/lib/grappa` — the measured Docker shape. No
    # `releases/` dir, no vsn suffix, so there is nothing to compare and
    # the fresh beams land where the node already looks.
    unversioned = Path.join([root, "_build", "dev", "lib", "grappa", "ebin"])
    File.mkdir_p!(unversioned)

    assert HotReload.audit_code_path(Path.dirname(unversioned)) == :ok
  end

  test "a release whose booted vsn is the one just built is clean" do
    root = tmp_root("aligned")
    release_tree!(root, ["1.5.1"], "1.5.1")

    assert HotReload.audit_code_path(lib_dir(root, "1.5.1")) == :ok
  end

  test "a STALE leftover lib dir alongside the booted one is not drift" do
    # The false positive the measurement forced out of the design:
    # `mix release --overwrite` does NOT prune, so every past vsn's lib
    # dir accumulates forever. Counting siblings would refuse every hot
    # deploy on a jail that has ever been bumped. The booted vsn IS the
    # built vsn here, so the node is loading exactly the fresh tree.
    root = tmp_root("leftover")
    release_tree!(root, ["1.4.0", "1.5.0", "1.5.1"], "1.5.1")

    assert HotReload.audit_code_path(lib_dir(root, "1.5.1")) == :ok
  end

  # ---- positive controls: the audit MUST refuse ------------------------

  test "the 2026-08-13 repro: the build wrote a sibling the booted node never reads" do
    # Measured shape after a VERSION-only bump: the boot dir survives
    # untouched, the fresh beams land in a sibling, and start_erl.data
    # moves to the new number. Today the reload walks the stale tree,
    # diffs it against itself and answers `{"reloaded":[],"failed":[]}` —
    # indistinguishable from "nothing to do", which is what served the
    # old BEAM for ~6.5 hours.
    root = tmp_root("drift")
    release_tree!(root, ["1.5.1", "9.9.9"], "9.9.9")

    assert {:error, {:stale_code_path, drift}} = HotReload.audit_code_path(lib_dir(root, "1.5.1"))
    assert drift.booted == "1.5.1"
    assert drift.built == "9.9.9"
    assert drift.lib_dir == lib_dir(root, "1.5.1")
  end

  test "a boot dir the build deleted refuses too, and names the vsn that replaced it" do
    # The same defect from the other side: nothing guarantees the boot
    # dir survives, and a node walking a path that no longer exists finds
    # zero beams — the same silent `{"reloaded":[],"failed":[]}`.
    root = tmp_root("vanished")
    release_tree!(root, ["9.9.9"], "9.9.9")

    assert {:error, {:stale_code_path, drift}} = HotReload.audit_code_path(lib_dir(root, "1.5.1"))
    assert drift.booted == "1.5.1"
    assert drift.built == "9.9.9"
  end

  test "an unreadable start_erl.data refuses rather than guessing — in doubt, cold" do
    # A versioned lib path says "this is a mix release", so the release
    # metadata is expected to be there. Reading `:ok` out of its absence
    # would restore exactly the silence this audit exists to break.
    root = tmp_root("nometa")
    release_tree!(root, ["1.5.1"], nil)

    assert {:error, {:stale_code_path, drift}} = HotReload.audit_code_path(lib_dir(root, "1.5.1"))
    assert drift.booted == "1.5.1"
    assert drift.built == nil
  end

  test "a malformed start_erl.data refuses and reports what it could not parse" do
    root = tmp_root("garbage")
    release_tree!(root, ["1.5.1"], "1.5.1")
    File.write!(Path.join([root, "releases", "start_erl.data"]), "not-a-pair\n")

    assert {:error, {:stale_code_path, drift}} = HotReload.audit_code_path(lib_dir(root, "1.5.1"))
    assert drift.built == nil
  end

  # ---- the refusal must survive the wire -------------------------------

  test "the drift payload is JSON-encodable — it is a 409 body, not a log line" do
    root = tmp_root("json")
    release_tree!(root, ["1.5.1", "9.9.9"], "9.9.9")

    {:error, {:stale_code_path, drift}} = HotReload.audit_code_path(lib_dir(root, "1.5.1"))

    decoded = drift |> Jason.encode!() |> Jason.decode!()
    assert decoded["booted"] == "1.5.1"
    assert decoded["built"] == "9.9.9"
  end
end
