defmodule Grappa.UploadsConcurrencyTest do
  @moduledoc """
  Issue 2403 — two uploads racing for the last room under a cap: exactly one
  is stored.

  The caps (global + per-subject) are summed live off `uploads`, so a write
  that reads the totals and inserts its row in two separate steps lets a
  second writer read the SAME totals in between, and both land. The fix puts
  the authoritative re-check and the insert in one `Repo.immediate_transaction/1`
  inside `Grappa.Uploads.create/4`; these tests drive the interleaves that
  separate the two shapes.

  ## How the interleave is forced

  The same harness as `Grappa.UserSettingsConcurrencyTest`: Ecto's per-query
  telemetry (`[:grappa, :repo, :query]`) runs its handlers synchronously in
  the process that issued the query, so a handler that blocks on one of the
  first writer's `uploads` SELECTs suspends it at a chosen point, and the
  second writer is signalled from inside that window. No production test
  seam, no sleep-and-hope. Two windows:

    * **after the pre-check** — the issue's own window, the gap a
      check-then-write door left open. The peer commits there, and the
      first writer's in-transaction re-check must refuse it and remove the
      file it already wrote.
    * **inside the transaction** — between the authoritative read and the
      insert. The peer must wait for the commit, then be refused.

  ## What the harness substitutes

  In production the two writers hold two pool connections and the second one
  waits on SQLite's file-level write lock at `BEGIN IMMEDIATE`, then re-reads
  the totals. The Sandbox has ONE connection (`config/test.exs`,
  `pool_size: 1`), so here the second writer blocks on the checkout the open
  transaction holds — same serialisation, different lock. The in-transaction
  window therefore proves that the re-check and the insert are ONE
  transaction; it does not prove the `:immediate` spelling of it (invisible under the Sandbox,
  where every nested mode is a `SAVEPOINT`).
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures, only: [user_fixture: 1]

  alias Grappa.Uploads
  alias Grappa.Uploads.Upload

  @handler_id {__MODULE__, :pause}

  # How long the paused writer waits for the other one. In the in-transaction
  # window it is reached only when the other writer is BLOCKED (the fixed
  # shape), so it is a per-test cost, not a timing guess: generous on purpose,
  # because a window too short to let an UNGUARDED writer commit would turn
  # the defect green.
  @peer_grace_ms 1_000

  @unreachable_cap 1_000_000_000

  setup do
    root = Path.join(System.tmp_dir!(), "grappa_uploads_race_#{System.unique_integer([:positive])}")
    File.mkdir_p!(root)
    on_exit(fn -> File.rm_rf!(root) end)
    %{root: root}
  end

  # Spawns the second writer, then arms a pause on the first writer's first
  # `uploads` SELECT that `window?` accepts. `peer_upload` runs only once the
  # first writer is inside that window, and the pause ends as soon as the
  # peer reports back (or the grace runs out, when the peer is blocked).
  defp interleave(window?, peer_upload) do
    parent = self()

    peer =
      spawn(fn ->
        receive do
          :go -> send(parent, {:peer_done, peer_upload.()})
        end
      end)

    Ecto.Adapters.SQL.Sandbox.allow(Grappa.Repo, parent, peer)

    :telemetry.attach(
      @handler_id,
      [:grappa, :repo, :query],
      # `:telemetry` handler args: event, measurements, metadata, config.
      fn _, _, meta, _ ->
        query = meta[:query] || ""

        if self() == parent and meta[:source] == "uploads" and
             String.starts_with?(query, "SELECT") and Process.get(@handler_id) == nil and
             window?.(query) do
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

  # Between the authoritative re-check and the insert: inside the transaction.
  defp in_transaction?(_query), do: Grappa.Repo.in_transaction?()

  # Between the cheap pre-check and the transaction — the issue's own window.
  # The pre-check reads the global sum, then the subject's: pausing on the
  # SUBJECT read means both of its reads are done, so the peer commits into
  # exactly the gap a check-then-write door left open.
  defp after_precheck?(query),
    do: not Grappa.Repo.in_transaction?() and String.contains?(query, "user_id")

  defp upload(root, subject, byte_count, caps) do
    Uploads.create(
      String.duplicate("a", byte_count),
      %{
        subject: subject,
        mime: "text/plain",
        expires_at: DateTime.add(DateTime.utc_now(), 3600, :second)
      },
      caps,
      storage_root: root
    )
  end

  defp race(root, {first_subject, second_subject}, caps, window?) do
    interleave(window?, fn -> upload(root, second_subject, 8, caps) end)

    first = upload(root, first_subject, 8, caps)
    assert_receive {:peer_done, second}, 2_000
    assert Process.get(@handler_id) == :fired, "the interleave never armed"

    {outcome(first), outcome(second)}
  end

  defp outcome({:ok, %Upload{}}), do: :stored
  defp outcome({:error, :insufficient_storage}), do: :insufficient_storage

  defp user_caps(cap), do: %{global: @unreachable_cap, user: cap, visitor: @unreachable_cap}

  describe "one subject's last room" do
    test "a peer committing between the pre-check and the insert: the re-check refuses, its file is removed",
         %{root: root} do
      user = user_fixture([])
      subject = {:user, user.id}

      # The first writer passed the pre-check on an empty store, so only the
      # in-transaction re-check stands between it and a 16-byte total.
      assert race(root, {subject, subject}, user_caps(10), &after_precheck?/1) ==
               {:insufficient_storage, :stored}

      assert [%Upload{bytes: 8}] = Uploads.list_all()
      assert length(File.ls!(root)) == 1
    end

    test "a peer arriving inside the transaction waits for it, then is refused", %{root: root} do
      user = user_fixture([])
      subject = {:user, user.id}

      assert race(root, {subject, subject}, user_caps(10), &in_transaction?/1) ==
               {:stored, :insufficient_storage}

      assert [%Upload{bytes: 8}] = Uploads.list_all()
      assert length(File.ls!(root)) == 1
    end
  end

  describe "the global budget's last room" do
    test "two subjects: a peer committing between the pre-check and the insert is the only one stored",
         %{root: root} do
      me = user_fixture([])
      other = user_fixture([])
      caps = %{global: 10, user: @unreachable_cap, visitor: @unreachable_cap}

      assert race(root, {{:user, me.id}, {:user, other.id}}, caps, &after_precheck?/1) ==
               {:insufficient_storage, :stored}

      assert Uploads.live_bytes_sum() == 8
      assert length(File.ls!(root)) == 1
    end
  end
end
