defmodule Grappa.Push.VendorLogTest do
  @moduledoc """
  #1321 — the push service's OWN words on a rejected delivery.

  `async: false`: the handler is a globally-attached `:telemetry`
  handler under a fixed id, and the assertions read the shared Logger
  stream via `capture_log/1`. The singleton boots with
  `attach_telemetry: false` under test (`config/test.exs`, mirror of
  `Grappa.DbLatency`), so each test attaches the production handler
  function explicitly.

  The events emitted here have the shape `Grappa.Push.Sender` emits on
  a non-terminal rejection (#2401): the status, the vendor HOST, and the
  response body. Which deliveries emit at all — never a 2xx, never the
  terminal 404 / 410 — is the sender's to decide and is pinned in
  `Grappa.Push.SenderTest`.
  """
  use ExUnit.Case, async: false

  import ExUnit.CaptureLog

  alias Grappa.Push.VendorLog

  @handler_id "grappa-push-vendor-log-test"
  @event [:grappa, :push, :vendor_rejection]

  setup do
    :ok = :telemetry.attach(@handler_id, @event, &VendorLog.handle_telemetry/4, nil)
    on_exit(fn -> :telemetry.detach(@handler_id) end)
    :ok
  end

  defp emit(metadata) do
    :telemetry.execute(@event, %{}, Map.new(metadata))
  end

  defp rejection(overrides) do
    Map.merge(
      %{
        status: 400,
        vendor: "push.example.invalid",
        body: ~s({"reason":"VapidPkHashMismatch"})
      },
      Map.new(overrides)
    )
  end

  describe "vendor rejections" do
    test "logs the vendor's reason, not just the status" do
      log = capture_log(fn -> emit(rejection([])) end)

      assert log =~ "VapidPkHashMismatch"
    end

    test "logs the HTTP status alongside the reason" do
      log = capture_log(fn -> emit(rejection(status: 403)) end)

      assert log =~ "403"
    end

    test "names the host so the line stands on its own" do
      log = capture_log(fn -> emit(rejection([])) end)

      assert log =~ "push.example.invalid"
    end

    test "caps the body — a vendor may answer with a whole error page" do
      body = String.duplicate("a", 4000) <> "TAIL_OF_THE_BODY"

      log = capture_log(fn -> emit(rejection(body: body)) end)

      refute log =~ "TAIL_OF_THE_BODY"
    end

    test "says so when it truncated" do
      log = capture_log(fn -> emit(rejection(body: String.duplicate("a", 4000))) end)

      assert log =~ "truncated"
    end

    test "keeps the reason on ONE line — the log is grepped, not parsed" do
      log = capture_log(fn -> emit(rejection(body: "line one\nline two")) end)

      assert log =~ "line one line two"
    end

    test "survives a body that is not valid UTF-8" do
      log = capture_log(fn -> emit(rejection(body: <<0xFF, 0xFE, "Bad">>)) end)

      assert log =~ "Bad"
    end
  end
end
