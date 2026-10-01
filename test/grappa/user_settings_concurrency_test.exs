defmodule Grappa.UserSettingsConcurrencyTest do
  @moduledoc """
  #1375 — two writers, two DIFFERENT `data` keys, neither write lost.

  `user_settings.data` is one JSON column, so every setter writes it WHOLE.
  A setter that reads the blob, merges its key and writes it back drops any
  key another writer committed in between — silently, with `{:ok, _}` on both
  sides. The pair driven here is the pair the issue names as reachable in
  production: `put_last_client_prefix64/2` fires from
  `Grappa.Vhosts.record_client_source/2` on every client connect — since
  #1618 from a detached `Grappa.TaskSupervisor` task rather than the socket
  process itself — while a settings-drawer PUT runs in another. The detach
  moves which process races, not whether one does, so the pair below is the
  same pair.

  ## How the interleave is forced

  Ecto's per-query telemetry (`[:grappa, :repo, :query]`, the event
  `Grappa.DbLatency` already folds) runs its handlers SYNCHRONOUSLY in the
  process that issued the query. Attaching a handler that blocks on the
  writer's `user_settings` SELECT therefore suspends it exactly between its
  read and its write — no production code has a test seam in it, and there is
  no sleep-and-hope: the second writer is signalled from inside that window.

  ## What the harness substitutes, and what it therefore cannot buy

  In production the two writers hold two of the pool's ten connections and
  the serialisation comes from SQLite's file-level write lock: the second
  `BEGIN IMMEDIATE` waits out `busy_timeout` and its read then sees the first
  writer's commit. The Sandbox has ONE connection (`config/test.exs`,
  `pool_size: 1`), so here the second writer blocks on the checkout the open
  transaction holds. Same serialisation, different lock — which is why these
  tests prove that the read and the write are ONE transaction, and do NOT
  prove the `:immediate` spelling of it. That distinction is invisible at
  runtime under the Sandbox (nested, every mode is a `SAVEPOINT`) and both
  tests stay green with `Repo.transaction/1` — measured, not assumed.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.UserSettings
  alias Grappa.UserSettings.Settings

  @handler_id {__MODULE__, :pause_between_read_and_write}

  # How long the paused writer waits for the other one. Reached only when the
  # other writer is BLOCKED (the fixed shape), so it is a per-test cost, not a
  # timing guess: generous on purpose, because a window too short to let an
  # UNGUARDED writer commit would turn the defect green.
  @peer_grace_ms 1_000

  # Spawns the second writer, then arms the pause. `peer_write` runs only once
  # the paused writer has read, and the pause ends as soon as it reports back.
  defp interleave(subject, peer_write) do
    parent = self()

    peer =
      spawn(fn ->
        receive do
          :go -> send(parent, {:peer_done, peer_write.(subject)})
        end
      end)

    Ecto.Adapters.SQL.Sandbox.allow(Grappa.Repo, parent, peer)

    :telemetry.attach(
      @handler_id,
      [:grappa, :repo, :query],
      # `:telemetry` handler args: event, measurements, metadata, config.
      fn _, _, meta, _ ->
        if self() == parent and meta[:source] == "user_settings" and
             String.starts_with?(meta[:query] || "", "SELECT") and
             Process.get(@handler_id) == nil do
          Process.put(@handler_id, :fired)
          send(peer, :go)

          receive do
            {:peer_done, _} = landed -> send(parent, landed)
          after
            @peer_grace_ms -> :ok
          end
        end
      end,
      nil
    )

    ExUnit.Callbacks.on_exit(fn -> :telemetry.detach(@handler_id) end)
  end

  defp write_prefix(subject), do: UserSettings.put_last_client_prefix64(subject, "AABB")

  test "a setter does not drop a key another writer commits between its read and its write" do
    user = user_fixture()
    subject = {:user, user.id}
    {:ok, _} = UserSettings.get_or_init(subject)

    interleave(subject, &write_prefix/1)

    assert {:ok, %Settings{}} = UserSettings.set_highlight_patterns(subject, ["ciao"])
    assert_receive {:peer_done, {:ok, %Settings{}}}, 2_000

    assert UserSettings.get_highlight_patterns(subject) == ["ciao"]
    assert UserSettings.get_last_client_prefix64(subject) == "AABB"
  end
end
