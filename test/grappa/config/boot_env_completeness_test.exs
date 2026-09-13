defmodule Grappa.Config.BootEnvCompletenessTest do
  @moduledoc """
  issue 2089 — every key `Grappa.Application.start/2` reaches with
  `Application.fetch_env!/2` must be SET in every env that boots the app,
  not only in `:prod`.

  `fetch_env!` raises rather than defaulting, and `start/2` runs it before
  a single child starts, so a key missing in one env is not a degraded
  feature: it is a boot crash with no supervisor to catch it. `:dcc_storage_root`
  was exactly that — derived in `config/runtime.exs` INSIDE
  `if config_env() == :prod`, absent from `config/dev.exs`, so under
  `MIX_ENV=dev` the app died at `application.ex` with
  `could not fetch application environment :dcc_storage_root`. That is the
  e2e harness (grappa-test runs `MIX_ENV=dev`) AND the local docker stack,
  both dead, while every other gate stayed green.

  Why the sibling suite did not catch it, which is the reason this file
  exists rather than another `describe` over there:
  `Grappa.Config.StorageRootsConfigTest` IS a class defence, it already
  names `:dcc_storage_root`, and it reads every config with `env: :prod`.
  Its axis is the SHAPE of a prod root (absolute, never CWD-relative —
  #1945). The axis here is orthogonal: whether the key is set AT ALL, in
  the envs prod is not. Measured when this was written: no test in the
  suite read `env: :dev` at all, so that axis had no gate on any key.

  The key list is EXTRACTED from `application.ex` rather than restated. A
  hand-written list is the same drift the defect came from — the fourth
  storage root would be added to the app and not to the list, and the gate
  would pass by describing a codebase that no longer exists.

  `async: false` — mutates the process-global OS env via `System.delete_env`.
  """
  use ExUnit.Case, async: false

  @application_ex Path.expand("../../../lib/grappa/application.ex", __DIR__)
  @config_exs Path.expand("../../../config/config.exs", __DIR__)
  @runtime_exs Path.expand("../../../config/runtime.exs", __DIR__)

  # Deleted before every read: the test container's own environment carries
  # these (compose.yaml forwards them), and an assertion that skipped this
  # would be reading the CONTAINER instead of the FILES — the same trap
  # `StorageRootsConfigTest.with_env/2` documents.
  @root_vars ~w(UPLOADS_STORAGE_ROOT PEER_AVATARS_STORAGE_ROOT DCC_STORAGE_ROOT CIC_DIST_ROOT)

  defp fetch_env_keys do
    ~r/Application\.fetch_env!\(:grappa, :(\w+)\)/
    |> Regex.scan(File.read!(@application_ex), capture: :all_but_first)
    |> List.flatten()
    |> Enum.map(&String.to_atom/1)
    |> Enum.uniq()
    |> Enum.sort()
  end

  # The `:grappa` config as a boot in `env` assembles it: the compile-time
  # layer (`config/config.exs`, which imports `#{env}.exs` at its tail) with
  # the runtime layer on top. Reading either alone would answer a question
  # no boot asks.
  defp grappa_config(env) do
    previous = Map.new(@root_vars, &{&1, System.get_env(&1)})
    Enum.each(@root_vars, &System.delete_env/1)

    try do
      @config_exs
      |> Config.Reader.read!(env: env)
      |> Config.Reader.merge(Config.Reader.read!(@runtime_exs, env: env))
      |> Keyword.fetch!(:grappa)
    after
      Enum.each(previous, fn
        {name, nil} -> System.delete_env(name)
        {name, value} -> System.put_env(name, value)
      end)
    end
  end

  defp assert_every_key_set(env) do
    keys = fetch_env_keys()
    grappa = grappa_config(env)
    missing = Enum.reject(keys, &Keyword.has_key?(grappa, &1))

    assert missing == [],
           "#{inspect(missing)} unset under #{inspect(env)} — Application.start/2 " <>
             "fetch_env!s #{inspect(missing)} and will raise before any child starts. " <>
             "Derive it in config/#{env}.exs, or hoist the runtime.exs read out of " <>
             "the prod block if the value must come from the environment."
  end

  describe "the extraction" do
    test "finds the keys it is meant to police" do
      # Positive control. A regex that stopped matching must fail here as a
      # broken pin, not pass the real assertions vacuously against [].
      keys = fetch_env_keys()

      assert length(keys) >= 4, "extracted #{length(keys)} keys from application.ex"
      assert :dcc_storage_root in keys
      assert :uploads_storage_root in keys
    end
  end

  describe "every env that boots resolves every fetch_env! key" do
    test "under :dev — the e2e harness and the local docker stack" do
      assert_every_key_set(:dev)
    end

    test "under :test" do
      assert_every_key_set(:test)
    end
  end
end
