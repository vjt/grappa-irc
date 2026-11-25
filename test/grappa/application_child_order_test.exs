defmodule Grappa.ApplicationChildOrderTest do
  # issue 2697 — the ORDER of the root supervisor's children, pinned on the
  # PRODUCTION shape.
  #
  # The child this file exists for, `Grappa.Net.SourceAliasManager`, is never
  # started by the test env (`:start_source_alias_manager` is false in
  # `config/test.exs`), so `Supervisor.which_children(Grappa.Supervisor)` cannot
  # see it. The first describe therefore builds the list through
  # `Grappa.Application.children/1` with every optional child switched on: the
  # list a production boot hands `Supervisor.start_link/2`. The second describe
  # proves that list IS the tree, by comparing the test boot's running children
  # with `children/1` of the test boot's own flags. Without it the first
  # describe would pin a function nobody is obliged to call.
  #
  # Direction matters twice for the manager, because the root is
  # `:one_for_one` and OTP stops children in REVERSE start order:
  #
  #   - START: the manager publishes the mode-2 arm gate in `init/1`. Every
  #     door that can resolve a session plan before Bootstrap sits behind the
  #     Endpoint, so the manager must be up before the Endpoint is.
  #   - STOP: a `Session.Server` releases its derived alias from `terminate/2`.
  #     The manager must therefore stop AFTER `SessionSupervisor`, i.e. start
  #     BEFORE it.
  use ExUnit.Case, async: true

  alias Grappa.Application, as: App
  alias Grappa.Net.SourceAliasManager

  # Every optional child on. identd's port and bind are the `config/runtime.exs`
  # defaults; `children/1` builds child specs and starts nothing, so they bind
  # no socket here.
  @production_flags %{
    start_bootstrap: true,
    start_endpoint: true,
    start_source_alias_manager: true,
    identd: [enabled: true, port: 10_113, bind: "::"]
  }

  describe "SourceAliasManager's place in the production child list" do
    setup do
      %{ids: ids(App.children(@production_flags))}
    end

    test "starts after the holder Registry its reconcile reads", %{ids: ids} do
      assert index!(ids, Grappa.SourceAliasHolders) < index!(ids, SourceAliasManager),
             "SourceAliasManager reads Grappa.SourceAliasHolders (held_source_fn) during its boot " <>
               "reconcile, so the Registry must already exist. Order: #{inspect(ids)}"
    end

    test "starts before SessionSupervisor, so it stops after every session", %{ids: ids} do
      assert index!(ids, SourceAliasManager) < index!(ids, Grappa.SessionSupervisor),
             "OTP stops children in reverse start order. With SourceAliasManager after " <>
               "SessionSupervisor it stops FIRST, so every Session.Server terminates into a dead " <>
               "manager: each release/1 exits :noproc and every derived lo0 alias outlives the " <>
               "shutdown until the next boot reconcile. Order: #{inspect(ids)}"
    end

    test "starts before the Endpoint, so the arm gate is published before any REST door", %{ids: ids} do
      assert index!(ids, SourceAliasManager) < index!(ids, GrappaWeb.Endpoint),
             "SourceAliasManager publishes the mode-2 arm gate in init/1. A REST door reached " <>
               "before that resolves a mode-2 plan against the not-armed default, the session is " <>
               "held, and its credential_failer marks the credential :failed, which is terminal: " <>
               "Bootstrap skips :failed credentials on every later boot. Order: #{inspect(ids)}"
    end

    test "starts before Bootstrap, so the first spawned session can acquire", %{ids: ids} do
      assert index!(ids, SourceAliasManager) < index!(ids, Grappa.Bootstrap),
             "Bootstrap spawns sessions that call SourceAliasManager.acquire/1 on their connect " <>
               "path. Order: #{inspect(ids)}"
    end
  end

  describe "the running tree" do
    test "is children/1 of the boot flags, in start order" do
      # Measured on OTP 28: `which_children/1` lists a static supervisor's
      # children in REVERSE start order, so it is reversed before comparing.
      # If an OTP upgrade changes that listing order, this assertion fails with
      # both lists printed; the remedy is to compare them as sets, not to drop
      # the check.
      running =
        Grappa.Supervisor
        |> Supervisor.which_children()
        |> Enum.map(fn {id, _, _, _} -> id end)
        |> Enum.reverse()

      built = ids(App.children(App.boot_flags()))

      assert running == built,
             "Grappa.Supervisor is not running children(boot_flags()): a child was started " <>
               "outside children/1, or the order differs.\nrunning: #{inspect(running)}\n" <>
               "built:   #{inspect(built)}"
    end
  end

  # The supervisor's own normalisation: the id it will register each child
  # under, which is what `which_children/1` reports.
  defp ids(children), do: Enum.map(children, &Supervisor.child_spec(&1, []).id)

  defp index!(ids, id) do
    case Enum.find_index(ids, &(&1 == id)) do
      nil -> flunk("#{inspect(id)} is not in the production child list: #{inspect(ids)}")
      index -> index
    end
  end
end
