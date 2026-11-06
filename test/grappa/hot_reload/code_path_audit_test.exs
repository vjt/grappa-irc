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
  # start_erl.data naming `built`, with `releases/<built>/grappa.rel`
  # beside it. The toolchain both declare is THIS VM's own (issue 1112), so
  # a tree built here is one the running node could have booted, and only
  # the vsn axis is under test. Returns the release root.
  defp release_tree!(root, lib_vsns, built) do
    Enum.each(lib_vsns, &File.mkdir_p!(Path.join([root, "lib", "grappa-#{&1}", "ebin"])))
    File.mkdir_p!(Path.join(root, "releases"))

    if built do
      File.write!(Path.join([root, "releases", "start_erl.data"]), "#{live_erts()} #{built}\n")
      write_rel!(root, built, live_erts(), for({app, vsn} <- live_apps(), do: {app, vsn, :permanent}))
    end

    root
  end

  defp lib_dir(root, vsn), do: Path.join([root, "lib", "grappa-#{vsn}"])

  # The toolchain this VM runs on, as the node reports it: the ERTS version
  # and every loaded application's vsn. The same calls the audit makes.
  defp live_erts, do: to_string(:erlang.system_info(:version))
  defp live_apps, do: for({app, _, vsn} <- Application.loaded_applications(), do: {app, to_string(vsn)})
  defp live_vsn(app), do: live_apps() |> List.keyfind(app, 0) |> elem(1)

  # `releases/<rel_vsn>/grappa.rel`, in the shape `mix release` writes it
  # (read off the v1.6.2 .deb: `{release,{"grappa","0.0.0"},{erts,"16.4"},
  # [{kernel,"10.6.3",permanent}, …, {iex,"1.19.5",none}, …]}.`).
  defp write_rel!(root, rel_vsn, erts, apps) do
    term =
      {:release, {~c"grappa", to_charlist(rel_vsn)}, {:erts, to_charlist(erts)},
       for({app, vsn, type} <- apps, do: {app, to_charlist(vsn), type})}

    path = Path.join([root, "releases", rel_vsn, "grappa.rel"])
    File.mkdir_p!(Path.dirname(path))
    File.write!(path, :io_lib.format(~c"~tp.~n", [term]))
  end

  # A release whose app vsn is the booted one, so the vsn audit passes and
  # whatever refuses is the toolchain. `start_erl_erts` goes into
  # start_erl.data; the .rel carries `rel_erts` and `apps`.
  defp toolchain_tree!(root, start_erl_erts, rel_erts, apps) do
    File.mkdir_p!(Path.join([root, "lib", "grappa-0.0.0", "ebin"]))
    File.mkdir_p!(Path.join(root, "releases"))
    File.write!(Path.join([root, "releases", "start_erl.data"]), "#{start_erl_erts} 0.0.0\n")
    write_rel!(root, "0.0.0", rel_erts, apps)
    lib_dir(root, "0.0.0")
  end

  defp live_rel_apps, do: for({app, vsn} <- live_apps(), do: {app, vsn, :permanent})

  defp with_vsn(apps, app, vsn), do: List.keyreplace(apps, app, 0, {app, vsn, :permanent})

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

  # ---- the toolchain (issue 1112) ---------------------------------------
  #
  # The app vsn has been frozen since issue 2057, so the lib dir no longer
  # moves; the toolchain still does. Measured on real artefacts (issue 1112,
  # phase 1): Arch 1.5.6 -> 1.6.0 moved erts 17.0.6 -> 17.1 and Elixir
  # 1.20.2 -> 1.20.4, the rpm moved Elixir 1.19.5 -> 1.19.6 alone, the OCI
  # image moved both, and the repo changed in none of those hops. The vsn
  # audit reads only field 2 of start_erl.data and called every one of them
  # clean, so a reload would have loaded beams built by one Elixir into a
  # node running another.

  test "an ERTS the running node does not run refuses (the Arch hop)" do
    refute live_erts() == "17.1"
    root = tmp_root("erts")

    lib = toolchain_tree!(root, "17.1", "17.1", live_rel_apps())

    assert {:error, {:stale_toolchain, drift}} = HotReload.audit_code_path(lib)
    assert drift.release == root
    assert drift.moved == [%{name: "erts", running: live_erts(), built: "17.1"}]
  end

  test "an Elixir the running node does not run refuses, with ERTS unchanged (the rpm hop)" do
    root = tmp_root("elixir")
    refute live_vsn(:elixir) == "0.0.1"

    lib = toolchain_tree!(root, live_erts(), live_erts(), with_vsn(live_rel_apps(), :elixir, "0.0.1"))

    assert {:error, {:stale_toolchain, drift}} = HotReload.audit_code_path(lib)
    assert drift.moved == [%{name: "elixir", running: live_vsn(:elixir), built: "0.0.1"}]
  end

  test "start_erl.data and the .rel are each read: either one naming another ERTS refuses" do
    # Both fields describe the same release and a coherent build writes the
    # same ERTS into each; one that does not is doubt, and doubt is cold.
    start_erl_only = toolchain_tree!(tmp_root("start_erl_only"), "17.1", live_erts(), live_rel_apps())

    assert {:error, {:stale_toolchain, %{moved: [%{name: "erts", built: "17.1"}]}}} =
             HotReload.audit_code_path(start_erl_only)

    rel_only = toolchain_tree!(tmp_root("rel_only"), live_erts(), "17.1", live_rel_apps())

    assert {:error, {:stale_toolchain, %{moved: [%{name: "erts", built: "17.1"}]}}} =
             HotReload.audit_code_path(rel_only)
  end

  test "an application the release loads and the node never loaded refuses" do
    # A dependency added under --force-hot: the boot script would load it,
    # the running node has nothing of it.
    root = tmp_root("new_app")
    lib = toolchain_tree!(root, live_erts(), live_erts(), [{:not_loaded_here, "1.0.0", :permanent} | live_rel_apps()])

    assert {:error, {:stale_toolchain, drift}} = HotReload.audit_code_path(lib)
    assert drift.moved == [%{name: "not_loaded_here", running: nil, built: "1.0.0"}]
  end

  test "an application the release lists as none is not loaded at boot, so it is not compared" do
    # `{iex,"1.19.5",none}` in every real .rel: the boot script never loads
    # it, so its absence from the node says nothing.
    root = tmp_root("none_app")
    lib = toolchain_tree!(root, live_erts(), live_erts(), [{:not_loaded_here, "1.0.0", :none} | live_rel_apps()])

    assert HotReload.audit_code_path(lib) == :ok
  end

  test "a release with no .rel refuses rather than guessing, in doubt, cold" do
    root = tmp_root("no_rel")
    lib = toolchain_tree!(root, live_erts(), live_erts(), live_rel_apps())
    File.rm!(Path.join([root, "releases", "0.0.0", "grappa.rel"]))

    assert {:error, {:stale_toolchain, drift}} = HotReload.audit_code_path(lib)
    assert drift.moved == nil
  end

  test "the toolchain drift is JSON-encodable, it is a 409 body as well" do
    root = tmp_root("toolchain_json")
    lib = toolchain_tree!(root, "17.1", "17.1", live_rel_apps())

    {:error, {:stale_toolchain, drift}} = HotReload.audit_code_path(lib)

    decoded = drift |> Jason.encode!() |> Jason.decode!()
    assert decoded["release"] == root
    assert decoded["moved"] == [%{"name" => "erts", "running" => live_erts(), "built" => "17.1"}]
  end
end
