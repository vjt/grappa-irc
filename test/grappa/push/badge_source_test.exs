defmodule Grappa.Push.BadgeSourceTest do
  @moduledoc """
  Door #1 injection seam (2026-06-21). Covers the resilience contract:
  when `:badge_source` is unconfigured (the transient hot-deploy window —
  new code loaded, `config.exs` not yet re-applied), `count/1` returns
  `nil` so the push path omits the badge instead of crashing the
  fire-and-forget `Task`.

  `async: false` — mutates the global `:grappa, :badge_source` app env.
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
    original = Application.get_env(:grappa, :badge_source)

    on_exit(fn ->
      if original do
        Application.put_env(:grappa, :badge_source, original)
      else
        Application.delete_env(:grappa, :badge_source)
      end
    end)

    :ok
  end

  test "impl/0 returns the configured module" do
    Application.put_env(:grappa, :badge_source, StubSource)
    assert BadgeSource.impl() == StubSource
  end

  test "count/1 delegates to the configured implementation" do
    Application.put_env(:grappa, :badge_source, StubSource)
    assert BadgeSource.count({:user, Ecto.UUID.generate()}) == 42
  end

  test "count/1 returns nil when no implementation is configured (hot-deploy window)" do
    Application.delete_env(:grappa, :badge_source)
    assert BadgeSource.impl() == nil
    assert BadgeSource.count({:user, Ecto.UUID.generate()}) == nil
  end

  test "the production default resolves to Grappa.Push.BadgeCount" do
    # config/config.exs wires the real implementation; guards against a
    # dropped default leaving door #1 permanently badge-less.
    assert Application.get_env(:grappa, :badge_source) == Grappa.Push.BadgeCount
  end
end
