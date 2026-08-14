defmodule Grappa.Push.VendorLogTest do
  @moduledoc """
  #1321 — the push service's OWN words on a rejected delivery.

  `async: false`: the handler is a globally-attached `:telemetry`
  handler under a fixed id, and the assertions read the shared Logger
  stream via `capture_log/1`. The singleton boots with
  `attach_telemetry: false` under test (`config/test.exs`, mirror of
  `Grappa.DbLatency`), so each test attaches the production handler
  function explicitly.

  The events emitted here are the ones `ExNudge.Telemetry` actually
  produces: a non-2xx response yields an integer `http_status_code`
  with the response BODY as `error_reason`, while the terminal 410 /
  413 and the transport failures yield a nil `http_status_code` and an
  atom-or-inspected reason. That split is what the handler keys on, so
  the fixtures pin it.
  """
  use ExUnit.Case, async: false

  import ExUnit.CaptureLog

  alias Grappa.Push.VendorLog

  @handler_id "grappa-push-vendor-log-test"
  @event [:ex_nudge, :send_notification]

  # An endpoint in the shape the telemetry event carries it. The path
  # segment is treated as a credential — the handler records the host
  # and nothing else.
  @endpoint "https://push.example.invalid/vXrN4tPq2Ke"

  setup do
    :ok = :telemetry.attach(@handler_id, @event, &VendorLog.handle_telemetry/4, nil)
    on_exit(fn -> :telemetry.detach(@handler_id) end)
    :ok
  end

  defp emit(metadata) do
    :telemetry.execute(@event, %{duration: 12, payload_size: 200}, Map.new(metadata))
  end

  defp rejection(overrides) do
    Map.merge(
      %{
        endpoint: @endpoint,
        status: :error,
        http_status_code: 400,
        error_reason: ~s({"reason":"VapidPkHashMismatch"})
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
      log = capture_log(fn -> emit(rejection(http_status_code: 403)) end)

      assert log =~ "403"
    end

    test "names the host so the line stands on its own" do
      log = capture_log(fn -> emit(rejection([])) end)

      assert log =~ "push.example.invalid"
    end

    test "never prints the endpoint path — a path segment can itself be a credential" do
      log = capture_log(fn -> emit(rejection([])) end)

      refute log =~ "vXrN4tPq2Ke"
    end

    test "caps the body — a vendor may answer with a whole error page" do
      body = String.duplicate("a", 4000) <> "TAIL_OF_THE_BODY"

      log = capture_log(fn -> emit(rejection(error_reason: body)) end)

      refute log =~ "TAIL_OF_THE_BODY"
    end

    test "says so when it truncated" do
      log = capture_log(fn -> emit(rejection(error_reason: String.duplicate("a", 4000))) end)

      assert log =~ "truncated"
    end

    test "keeps the reason on ONE line — the log is grepped, not parsed" do
      log = capture_log(fn -> emit(rejection(error_reason: "line one\nline two")) end)

      assert log =~ "line one line two"
    end

    test "survives a body that is not valid UTF-8" do
      log = capture_log(fn -> emit(rejection(error_reason: <<0xFF, 0xFE, "Bad">>)) end)

      assert log =~ "Bad"
    end
  end

  describe "events the sender already reports" do
    test "stays silent on a delivered notification" do
      log =
        capture_log(fn ->
          emit(%{endpoint: @endpoint, status: :success, http_status_code: 201, error_reason: nil})
        end)

      refute log =~ "push.vendor"
    end

    test "stays silent when there is no vendor body to add (410, transport failure)" do
      log =
        capture_log(fn ->
          emit(rejection(http_status_code: nil, error_reason: :subscription_expired))
        end)

      refute log =~ "push.vendor"
    end
  end
end
