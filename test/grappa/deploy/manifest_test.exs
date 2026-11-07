defmodule Grappa.Deploy.ManifestTest do
  # async: true — reads files and compiled data, writes only its own tmp files.
  use ExUnit.Case, async: true

  import ExUnit.CaptureIO

  alias Grappa.Deploy.{Manifest, Preflight}

  @apply_upgrade "infra/packaging/apply-upgrade.sh"

  describe "current/0 — the manifest compiled into this build" do
    test "equals the manifest of the files on disk now — the snapshot is not stale" do
      # The compiled manifest is what a running node reports about itself, so
      # a build that missed a file (a migration added without a recompile)
      # would report the wrong "from" on the next upgrade. Rebuilding it from
      # disk with the same two functions must give the same value.
      root = File.cwd!()

      on_disk =
        root
        |> Preflight.manifest_paths()
        |> Map.new(fn path -> {path, read_or_nil(Path.join(root, path))} end)
        |> Preflight.build_manifest()

      assert Manifest.current() == on_disk
    end

    test "watches every migration and every long-lived module on disk" do
      files = Manifest.current().files
      migrations = Path.wildcard("priv/repo/migrations/*.exs")

      assert length(migrations) > 50
      assert Enum.reject(migrations, &Map.has_key?(files, &1)) == []
      assert Enum.reject(Preflight.long_lived_module_files(), &Map.has_key?(files, &1)) == []
    end

    test "a file's entry is the sha256 of what is on disk" do
      assert Manifest.current().files["mix.lock"] ==
               Base.encode16(:crypto.hash(:sha256, File.read!("mix.lock")), case: :lower)
    end
  end

  describe "encode/0, encode/1 and decode/1" do
    test "the encoding round-trips to the compiled manifest" do
      assert {:ok, Manifest.current()} == Manifest.decode(Manifest.encode())
    end

    test "encode/0 is the compiled manifest's encoding" do
      assert Manifest.encode() == Manifest.encode(Manifest.current())
    end

    test "text that is not a manifest is refused, not guessed at" do
      assert {:error, :unknown_format} = Manifest.decode("not base64 at all!")
      assert {:error, :unknown_format} = Manifest.decode(Base.encode64("junk"))

      assert {:error, :unknown_format} =
               Manifest.decode(Base.encode64(:erlang.term_to_binary({:grappa_manifest, 999, %{}})))
    end
  end

  describe "run/1 — the verdict apply-upgrade.sh reads" do
    @tag :tmp_dir
    test "the running node reported THIS build → hot, exit 0", %{tmp_dir: dir} do
      path = write_manifest(dir, Manifest.current())
      assert {0, text} = Manifest.run([path])
      assert text =~ "HOT"
    end

    @tag :tmp_dir
    test "the running node's config differs → cold, exit 3, naming the file", %{tmp_dir: dir} do
      from = put_in(Manifest.current(), [:files, "config/runtime.exs"], "0000")
      assert {3, text} = Manifest.run([write_manifest(dir, from)])
      assert text =~ "config/runtime.exs"
    end

    @tag :tmp_dir
    test "a migration the running node lacks is classified from the NEW release's priv",
         %{tmp_dir: dir} do
      # Read through the real release path, not handed in: the two pinned
      # real migrations, one HOT and one COLD by the classifier's own rule.
      hot = "priv/repo/migrations/20260805100000_add_old_nick_to_session_log_events.exs"
      cold = "priv/repo/migrations/20260515111331_visitors_expires_at_nullable.exs"

      from = update_in(Manifest.current(), [:files], &Map.delete(&1, hot))
      assert {0, _} = Manifest.run([write_manifest(dir, from)])

      from = update_in(Manifest.current(), [:files], &Map.delete(&1, cold))
      assert {3, text} = Manifest.run([write_manifest(dir, from)])
      assert text =~ cold
    end

    test "a file that cannot be read → exit 3 with the reason, never a crash" do
      assert {3, text} = Manifest.run(["/nonexistent/upgrade-manifest"])
      assert text =~ "verdict unavailable"
    end

    @tag :tmp_dir
    test "a file that is not a manifest → exit 3 with the reason", %{tmp_dir: dir} do
      path = Path.join(dir, "junk")
      File.write!(path, "junk")
      assert {3, text} = Manifest.run([path])
      assert text =~ "verdict unavailable"
    end

    test "anything but one path is a usage error → exit 2" do
      assert {2, _} = Manifest.run([])
      assert {2, _} = Manifest.run(["a", "b"])
    end
  end

  describe "the contract with apply-upgrade.sh" do
    # The script and this module meet only through two Elixir expressions it
    # carries as strings. A rename here would leave the script calling
    # nothing, and every package upgrade would restart — safely, silently and
    # forever. These read the expressions out of the shipped script.
    test "RPC_EXPR, evaluated in a node that runs this build, prints its manifest" do
      Code.ensure_loaded!(Manifest)
      {_, printed} = with_io(fn -> Code.eval_string(script_expr("RPC_EXPR")) end)
      assert {:ok, Manifest.current()} == Manifest.decode(printed)
    end

    test "VERDICT_EXPR calls a function this module exports" do
      {{:., _, [mod, fun]}, _, args} = Code.string_to_quoted!(script_expr("VERDICT_EXPR"))
      mod = Macro.expand(mod, __ENV__)
      assert function_exported?(mod, fun, length(args))
    end
  end

  defp script_expr(name) do
    [_, expr] = Regex.run(~r/^#{name}='([^']*)'$/m, File.read!(@apply_upgrade))
    expr
  end

  defp write_manifest(dir, manifest) do
    path = Path.join(dir, "upgrade-manifest-#{System.unique_integer([:positive])}")
    File.write!(path, Manifest.encode(manifest))
    path
  end

  defp read_or_nil(path) do
    case File.read(path) do
      {:ok, source} -> source
      {:error, _} -> nil
    end
  end
end
