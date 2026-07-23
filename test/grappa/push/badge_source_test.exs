defmodule Grappa.Push.BadgeSourceTest do
  @moduledoc """
  Door #1 injection seam (2026-06-21). #364 J/cross-module-S2 migrated the
  resolution from a runtime `Application.get_env` read to a boot-time
  `:persistent_term` read (mirrors `Grappa.Admission.Config`).

  Covers the resilience contract: when `:badge_source` resolves to `nil`
  (the transient hot-deploy window — new code loaded, `boot/0` not yet
  re-run), `count/1` returns `nil` so the push path omits the badge instead
  of crashing the fire-and-forget `Task`.

  `async: false` — mutates the node-global `:persistent_term` seam key.
  """
  use ExUnit.Case, async: false

  alias Grappa.Push.BadgeSource

  defmodule StubSource do
    @moduledoc false
    @behaviour Grappa.Push.BadgeSource
    @impl Grappa.Push.BadgeSource
    def count(_), do: 42
  end

  setup do
    original = BadgeSource.impl()
    on_exit(fn -> BadgeSource.put_test_impl(original) end)
    :ok
  end

  test "boot/0 loads the config.exs default (Grappa.Push.BadgeCount) into persistent_term" do
    # config/config.exs wires the real implementation; boot/0 reads it once.
    # Guards against a dropped default leaving door #1 permanently badge-less.
    :ok = BadgeSource.boot()
    assert BadgeSource.impl() == Grappa.Push.BadgeCount
  end

  test "impl/0 returns the injected module" do
    BadgeSource.put_test_impl(StubSource)
    assert BadgeSource.impl() == StubSource
  end

  test "count/1 delegates to the injected implementation" do
    BadgeSource.put_test_impl(StubSource)
    assert BadgeSource.count({:user, Ecto.UUID.generate()}) == 42
  end

  test "count/1 returns nil when no implementation is configured (hot-deploy window)" do
    BadgeSource.put_test_impl(nil)
    assert BadgeSource.impl() == nil
    assert BadgeSource.count({:user, Ecto.UUID.generate()}) == nil
  end
end
