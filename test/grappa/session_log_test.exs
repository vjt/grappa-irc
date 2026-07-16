defmodule Grappa.SessionLogTest do
  @moduledoc """
  Unit coverage for the STATELESS emit surface of `Grappa.SessionLog`
  (#215 HALF 1): the `session_id/2` composite builder and the single
  `emit/3` path that fires a `[:grappa, :session, :log, <event>]`
  telemetry event AND a human-readable Logger line with structured
  metadata.

  The persistence sink (GenServer + Ecto) is covered separately once it
  exists; these tests pin the emit CONTRACT the sink consumes.

  `async: true` — emit/3 is a pure function (Logger + `:telemetry.execute`);
  the per-test telemetry handler is `attach`ed under a test-unique id and
  detached on exit, so no shared singleton is touched.
  """
  use ExUnit.Case, async: true

  import ExUnit.CaptureLog

  alias Grappa.SessionLog

  @nid 4242
  @slug "azzurra"

  defp base_state(subject) do
    %{subject: subject, network_id: @nid, network_slug: @slug, nick: "vjt"}
  end

  defp attach_capture(events) do
    ref = make_ref()
    parent = self()
    handler_id = {__MODULE__, ref}

    :ok =
      :telemetry.attach_many(
        handler_id,
        events,
        fn name, measurements, metadata, _ ->
          send(parent, {:telemetry, ref, name, measurements, metadata})
        end,
        nil
      )

    on_exit(fn -> :telemetry.detach(handler_id) end)
    ref
  end

  describe "session_id/2" do
    test "user subject → \"user:<uuid>:<network_id>\"" do
      assert SessionLog.session_id({:user, "abc-123"}, 7) == "user:abc-123:7"
    end

    test "visitor subject → \"visitor:<uuid>:<network_id>\"" do
      assert SessionLog.session_id({:visitor, "def-456"}, 9) == "visitor:def-456:9"
    end
  end

  describe "emit/3 telemetry contract" do
    test "connected fires [:grappa, :session, :log, :connected] with core metadata" do
      ref = attach_capture([[:grappa, :session, :log, :connected]])

      :ok = SessionLog.emit(:connected, base_state({:user, "u-1"}), [])

      assert_receive {:telemetry, ^ref, [:grappa, :session, :log, :connected], _measurements, md}
      assert md.session_id == "user:u-1:#{@nid}"
      assert md.event == :connected
      assert md.subject_kind == :user
      assert md.network_id == @nid
      assert md.network_slug == @slug
      assert md.nick == "vjt"
      # A wall-clock stamp is captured at emit time (persist-reliable).
      assert %DateTime{} = md.at
    end

    test "disconnected carries reason + clean + duration_ms" do
      ref = attach_capture([[:grappa, :session, :log, :disconnected]])

      :ok =
        SessionLog.emit(:disconnected, base_state({:visitor, "v-1"}),
          reason: ":tcp_closed",
          clean: false,
          duration_ms: 1234
        )

      assert_receive {:telemetry, ^ref, [:grappa, :session, :log, :disconnected], _m, md}
      assert md.session_id == "visitor:v-1:#{@nid}"
      assert md.reason == ":tcp_closed"
      assert md.clean == false
      assert md.duration_ms == 1234
    end

    test "backoff carries delay_ms + attempt" do
      ref = attach_capture([[:grappa, :session, :log, :backoff]])

      :ok = SessionLog.emit(:backoff, base_state({:user, "u-2"}), delay_ms: 5000, attempt: 3)

      assert_receive {:telemetry, ^ref, [:grappa, :session, :log, :backoff], _m, md}
      assert md.delay_ms == 5000
      assert md.attempt == 3
    end
  end

  describe "emit/3 Logger line" do
    test "disconnected (error) logs a warning line carrying nick + reason + session_id" do
      log =
        capture_log(fn ->
          SessionLog.emit(:disconnected, base_state({:user, "u-9"}),
            reason: ":tcp_closed",
            clean: false,
            duration_ms: 50
          )
        end)

      assert log =~ "session disconnected"
      assert log =~ "vjt"
      assert log =~ "tcp_closed"
      assert log =~ "user:u-9:#{@nid}"
    end

    test "deidentified (+r lost) logs a warning line" do
      # The other warning-level clause (info-level connected/registered are
      # covered transitively: their telemetry test would fail if log/2
      # raised, since emit fires telemetry AFTER the Logger line).
      log =
        capture_log(fn ->
          SessionLog.emit(:deidentified, base_state({:user, "u-4"}), [])
        end)

      assert log =~ "lost identification"
      assert log =~ "user:u-4:#{@nid}"
    end
  end
end
