defmodule Grappa.WindowCounts.PushSourceTest do
  @moduledoc """
  #267 per-message `window_counts` push DI-seam (mirrors
  `Grappa.Push.BadgeSource`). #364 J/cross-module-S2 migrated the
  resolution from a runtime `Application.get_env` read to a boot-time
  `:persistent_term` read (mirrors `Grappa.Admission.Config`).

  Covers the resilience contract: when `:window_counts_push_source`
  resolves to `nil` (the transient hot-deploy window — new code loaded,
  `boot/0` not yet re-run), `push/1` is a no-op so the Session.Server
  persist arm never crashes on a missing live-render optimization.

  `async: false` — mutates the node-global `:persistent_term` seam key.
  """
  use ExUnit.Case, async: false

  alias Grappa.WindowCounts.PushSource

  defmodule StubSource do
    @moduledoc false
    @behaviour Grappa.WindowCounts.PushSource
    @impl Grappa.WindowCounts.PushSource
    def push(ctx) do
      # `PushSource.push/1` resolves + invokes the impl synchronously in the
      # caller process, so `self()` here is the test process.
      send(self(), {:pushed, ctx})
      :ok
    end
  end

  @ctx %{
    subject: {:user, "u"},
    network_id: 1,
    network_slug: "libera",
    subject_label: "vjt",
    channel: "#chan",
    own_nick: "vjt"
  }

  setup do
    original = PushSource.impl()
    on_exit(fn -> PushSource.put_test_impl(original) end)
    :ok
  end

  test "boot/0 loads the config.exs default (Grappa.WindowCounts.Pusher) into persistent_term" do
    :ok = PushSource.boot()
    assert PushSource.impl() == Grappa.WindowCounts.Pusher
  end

  test "impl/0 returns the injected module" do
    PushSource.put_test_impl(StubSource)
    assert PushSource.impl() == StubSource
  end

  test "push/1 delegates to the injected implementation" do
    PushSource.put_test_impl(StubSource)
    assert PushSource.push(@ctx) == :ok
    assert_received {:pushed, @ctx}
  end

  test "push/1 is a no-op when no implementation is configured (hot-deploy window)" do
    PushSource.put_test_impl(nil)
    assert PushSource.push(@ctx) == :ok
    refute_received {:pushed, _}
  end
end
