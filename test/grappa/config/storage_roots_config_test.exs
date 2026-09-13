defmodule Grappa.Config.StorageRootsConfigTest do
  @moduledoc """
  #1945 — no storage root `config/runtime.exs` derives may be resolved
  against the BEAM's CWD.

  The CWD is not a value any operator sets or sees: it is whatever the init
  system left the process in. The v1.5.0 cold deploy on the production jail
  is what that cost — `rc.d/grappa` starts the release with
  `su -m grappa -c '.../bin/grappa daemon'` and no WorkingDirectory, so the
  CWD is `/`, the unset `PEER_AVATARS_STORAGE_ROOT` default
  `runtime/peer_avatars` resolved to `/runtime/peer_avatars`, and
  `Grappa.Avatars.Reaper.init/1`'s `File.mkdir_p!` died of `eacces` inside
  the supervision tree. That is a boot crash, not a degraded feature, and
  `Grappa.Uploads.Reaper.init/1` carries the same bang.

  It is a CLASS, not a key: `:uploads_storage_root`,
  `:peer_avatars_storage_root` and `:cic_dist_root` all defaulted to a
  CWD-relative literal. The second failure mode is quieter and worse — on
  the release image `WORKDIR /app` is writable, so `mkdir_p!` SUCCEEDS and
  the peer-avatar cache lands in the container layer, outside the `/data`
  volume, where the documented `pull` + `up -d` upgrade throws it away.

  The cure has one rule and two anchors, because the roots have two
  meanings:

    * DATA (uploads, peer avatars) hangs off `Path.dirname(DATABASE_PATH)`
      — the one absolute path prod already mandates, and exactly what
      "sibling of the sqlite DB" always meant.
    * CODE (the built SPA dist) has no data anchor, so an unset
      `CIC_DIST_ROOT` simply stops CLOBBERING the absolute build anchor
      `config/config.exs` already computes.

  An operator-supplied value is honored verbatim in both cases —
  re-anchoring a relative one would silently relocate an existing uploads
  directory — but a relative one earns a warning in prod naming the CWD it
  will be read against.

  The last two tests are drift pins rather than unit assertions: they read
  what each shipping substrate ALREADY declares and require the derivation
  to reproduce it, so "the new default equals the value already in force"
  is a gate rather than a claim in a commit message.

  `async: false` — mutates the process-global OS env via `System.put_env`.
  """
  use ExUnit.Case, async: false

  import ExUnit.CaptureLog

  @config_exs Path.expand("../../../config/config.exs", __DIR__)
  @runtime_exs Path.expand("../../../config/runtime.exs", __DIR__)
  @dockerfile_release Path.expand("../../../Dockerfile.release", __DIR__)
  @compose Path.expand("../../../compose.yaml", __DIR__)

  # The prod block raises on every missing secret, so a `Config.Reader` read
  # needs the full mandatory set. Values are shaped only as far as the file
  # inspects them (same set as `Grappa.RepoWalCheckpointTest`), MINUS
  # DATABASE_PATH: this suite varies that one.
  @prod_secrets %{
    "PHX_HOST" => "grappa.example.test",
    "SECRET_KEY_BASE" => String.duplicate("s", 64),
    "RELEASE_COOKIE" => String.duplicate("c", 64),
    "SECRET_SIGNING_SALT" => String.duplicate("t", 32),
    "GRAPPA_ENCRYPTION_KEY" => Base.encode64(String.duplicate("k", 32)),
    "VAPID_PUBLIC_KEY" => String.duplicate("p", 87),
    "VAPID_PRIVATE_KEY" => String.duplicate("q", 43)
  }

  @root_vars ["UPLOADS_STORAGE_ROOT", "PEER_AVATARS_STORAGE_ROOT", "DCC_STORAGE_ROOT", "CIC_DIST_ROOT"]

  # An absolute DATABASE_PATH in the packaged-install shape. Nothing writes
  # here — `Config.Reader` only builds the keyword list.
  @database_path "/var/lib/grappa/grappa.db"

  @root_keys [
    :uploads_storage_root,
    :peer_avatars_storage_root,
    :dcc_storage_root,
    :cic_dist_root
  ]

  # Run `fun` with EXACTLY `overrides` on top of the mandatory secrets: every
  # root var absent from `overrides` is DELETED, never inherited. The test
  # container's own environment sets all three (compose.yaml forwards them),
  # so an unset-default assertion that skipped this would be reading the
  # container instead of the file.
  defp with_env(overrides, fun) do
    desired = Map.merge(@prod_secrets, overrides)
    names = Enum.uniq(["DATABASE_PATH" | @root_vars] ++ Map.keys(desired))
    previous = Map.new(names, &{&1, System.get_env(&1)})

    Enum.each(names, fn name ->
      case Map.fetch(desired, name) do
        {:ok, value} -> System.put_env(name, value)
        :error -> System.delete_env(name)
      end
    end)

    try do
      fun.()
    after
      Enum.each(previous, fn
        {name, nil} -> System.delete_env(name)
        {name, value} -> System.put_env(name, value)
      end)
    end
  end

  # `:grappa`'s config as a prod boot assembles it: the compile-time layer
  # (`config/config.exs`, which a release bakes) with the runtime layer on
  # top. Reading runtime.exs ALONE would miss the base `:cic_dist_root` the
  # no-clobber arm exists to preserve.
  defp prod_grappa(overrides) do
    with_env(overrides, fn ->
      @config_exs
      |> Config.Reader.read!(env: :prod)
      |> Config.Reader.merge(Config.Reader.read!(@runtime_exs, env: :prod))
      |> Keyword.fetch!(:grappa)
    end)
  end

  defp baked_cic_dist_root do
    @config_exs
    |> Config.Reader.read!(env: :prod)
    |> get_in([:grappa, :cic_dist_root])
  end

  # First capture group, or nil. Every caller asserts non-nil BEFORE
  # comparing: a regex that stopped matching must fail as a broken pin, not
  # pass as an agreement between two nils.
  defp capture(regex, text) do
    case Regex.run(regex, text, capture: :all_but_first) do
      [value] -> value
      nil -> nil
    end
  end

  describe "absolute by construction — nothing resolves against the CWD" do
    test "every prod storage root is absolute when the operator sets none" do
      grappa = prod_grappa(%{"DATABASE_PATH" => @database_path})

      for key <- @root_keys do
        root = Keyword.fetch!(grappa, key)

        assert Path.type(root) == :absolute,
               "#{key} defaulted to #{inspect(root)} — a relative root is read against " <>
                 "the BEAM's CWD, which the init system chooses"
      end
    end

    test "the three DATA roots default to siblings of the sqlite database" do
      # Not a new convention: `runtime/uploads` was already DOCUMENTED as
      # "the sibling of the sqlite DB". This computes what that sentence
      # says instead of borrowing the CWD to approximate it.
      grappa = prod_grappa(%{"DATABASE_PATH" => @database_path})

      assert Keyword.fetch!(grappa, :uploads_storage_root) == "/var/lib/grappa/uploads"
      assert Keyword.fetch!(grappa, :peer_avatars_storage_root) == "/var/lib/grappa/peer_avatars"
      # issue 2089 — the DCC spool joined the class rather than being the
      # next root nobody set, which is how #1945 happened to the one above.
      assert Keyword.fetch!(grappa, :dcc_storage_root) == "/var/lib/grappa/dcc"
    end

    test "an unset CIC_DIST_ROOT leaves config.exs's absolute build anchor untouched" do
      # The dist is CODE, not data — packaged installs put it in
      # /usr/share/grappa while the DB is in /var/lib/grappa — so it gets no
      # DATABASE_PATH anchor. It does not need one: config/config.exs
      # already expands an absolute build anchor, and the defect was
      # runtime.exs OVERWRITING it with a relative literal, in every env
      # except :test.
      baked = baked_cic_dist_root()

      # Positive control: the thing being preserved must itself be absolute.
      assert Path.type(baked) == :absolute

      grappa = prod_grappa(%{"DATABASE_PATH" => @database_path})
      assert Keyword.fetch!(grappa, :cic_dist_root) == baked
    end

    test "an EMPTY value is treated as unset, never as an empty root" do
      # `System.get_env("X") || default` keeps "" — the empty string is
      # truthy in Elixir — so an empty var used to configure an empty root,
      # and `File.mkdir_p!("")` is not a directory. The file's own comment
      # claimed "Empty / unset = the CWD default"; only half of that was
      # true.
      grappa =
        prod_grappa(%{
          "DATABASE_PATH" => @database_path,
          "UPLOADS_STORAGE_ROOT" => "",
          "PEER_AVATARS_STORAGE_ROOT" => "",
          "DCC_STORAGE_ROOT" => "",
          "CIC_DIST_ROOT" => ""
        })

      assert Keyword.fetch!(grappa, :uploads_storage_root) == "/var/lib/grappa/uploads"
      assert Keyword.fetch!(grappa, :peer_avatars_storage_root) == "/var/lib/grappa/peer_avatars"
      assert Keyword.fetch!(grappa, :dcc_storage_root) == "/var/lib/grappa/dcc"
      assert Keyword.fetch!(grappa, :cic_dist_root) == baked_cic_dist_root()
    end
  end

  describe "operator-supplied roots" do
    test "an absolute root is honored verbatim" do
      grappa =
        prod_grappa(%{
          "DATABASE_PATH" => @database_path,
          "UPLOADS_STORAGE_ROOT" => "/srv/uploads",
          "PEER_AVATARS_STORAGE_ROOT" => "/srv/avatars",
          "CIC_DIST_ROOT" => "/usr/share/grappa/cicchetto-dist"
        })

      assert Keyword.fetch!(grappa, :uploads_storage_root) == "/srv/uploads"
      assert Keyword.fetch!(grappa, :peer_avatars_storage_root) == "/srv/avatars"
      assert Keyword.fetch!(grappa, :cic_dist_root) == "/usr/share/grappa/cicchetto-dist"
    end

    test "a relative root is kept verbatim and warns, naming the variable" do
      # Deliberately NOT re-anchored: `runtime/uploads` under Docker's
      # `WORKDIR /app` is a WORKING configuration that .env.example shipped
      # for a year, and joining it to the data root would silently move an
      # existing uploads directory to /app/runtime/runtime/uploads. The
      # value stands; what changes is that the CWD resolution stops being
      # invisible.
      log =
        capture_log(fn ->
          grappa =
            prod_grappa(%{
              "DATABASE_PATH" => @database_path,
              "UPLOADS_STORAGE_ROOT" => "runtime/uploads"
            })

          assert Keyword.fetch!(grappa, :uploads_storage_root) == "runtime/uploads"
        end)

      assert log =~ "UPLOADS_STORAGE_ROOT"
    end
  end

  describe "the anchor's precondition" do
    test "a RELATIVE DATABASE_PATH is refused with a message naming it" do
      # The anchor cannot deliver an absolute root from a relative DB path,
      # and a deployment with one is CWD-bound anyway (`Grappa.Repo.init/2`
      # mkdir_p's its parent). Refusing here is the explanatory error the
      # eacces never was. No shipped template writes a relative one.
      assert_raise RuntimeError, ~r/DATABASE_PATH/, fn ->
        prod_grappa(%{"DATABASE_PATH" => "runtime/grappa_prod.db"})
      end
    end
  end

  describe "substrate drift pins — the derivation must reproduce what ships" do
    test "the release image: each baked root is what the derivation computes" do
      dockerfile = File.read!(@dockerfile_release)

      database_path = capture(~r/ENV DATABASE_PATH=(\S+)/, dockerfile)
      uploads = capture(~r/UPLOADS_STORAGE_ROOT=(\S+)/, dockerfile)
      avatars = capture(~r/PEER_AVATARS_STORAGE_ROOT=(\S+)/, dockerfile)
      dcc = capture(~r/DCC_STORAGE_ROOT=(\S+)/, dockerfile)

      # Positive control on the extraction itself.
      assert database_path, "Dockerfile.release no longer bakes ENV DATABASE_PATH"
      assert uploads, "Dockerfile.release no longer bakes UPLOADS_STORAGE_ROOT"

      # The peer-avatar root is the #1945 data-loss leg: unset, the cache
      # landed in the container layer and every `pull` + `up -d` discarded
      # it. The image must name it, next to the other two.
      assert avatars, "Dockerfile.release does not bake PEER_AVATARS_STORAGE_ROOT"

      # issue 2089 — the DCC spool is the third data root, named here
      # BEFORE an incident rather than after one.
      assert dcc, "Dockerfile.release does not bake DCC_STORAGE_ROOT"

      data_root = Path.dirname(database_path)
      assert Path.join(data_root, "uploads") == uploads
      assert Path.join(data_root, "peer_avatars") == avatars
      assert Path.join(data_root, "dcc") == dcc
    end

    test "the dev compose stack: each fallback is what the derivation computes" do
      compose = File.read!(@compose)

      database_path = capture(~r/DATABASE_PATH: (\S+)/, compose)
      uploads = capture(~r/UPLOADS_STORAGE_ROOT:-([^}]+)\}/, compose)
      avatars = capture(~r/PEER_AVATARS_STORAGE_ROOT:-([^}]+)\}/, compose)
      dcc = capture(~r/DCC_STORAGE_ROOT:-([^}]+)\}/, compose)

      assert database_path, "compose.yaml no longer sets DATABASE_PATH"
      assert uploads, "compose.yaml no longer defaults UPLOADS_STORAGE_ROOT"
      assert avatars, "compose.yaml no longer defaults PEER_AVATARS_STORAGE_ROOT"
      assert dcc, "compose.yaml no longer defaults DCC_STORAGE_ROOT"

      # `${MIX_ENV:-dev}` sits in the BASENAME, so the data root is literal.
      data_root = Path.dirname(database_path)
      assert Path.join(data_root, "uploads") == uploads
      assert Path.join(data_root, "peer_avatars") == avatars
      assert Path.join(data_root, "dcc") == dcc
    end
  end
end
