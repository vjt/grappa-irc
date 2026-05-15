defmodule Grappa.Push.Sender do
  @moduledoc """
  Web Push delivery — sends VAPID-signed encrypted payloads to every
  push subscription belonging to a subject.

  Push notifications cluster B2 (2026-05-14). Sits between the trigger
  hot path (B4 — `Grappa.Push.Triggers`) and the upstream
  `WebPushElixir` library, owning the fan-out, dead-endpoint cleanup,
  and telemetry emission.

  ## Subject-scoped — V3 (2026-05-15)

  Both registered users and visitors own push subscriptions; the
  `send_to_subject/2` API takes a `Grappa.Subject.t()` tagged tuple
  and fans out across every row matching that subject FK column.

  ## Why a thin wrapper instead of inlining `WebPushElixir`

  Three concerns the upstream lib doesn't cover and B4 callers MUST
  NOT have to repeat at every call site:

    * **Fan-out across a subject's devices** — one PushEvent per
      registered subscription, parallelized so a single dead vendor
      doesn't block delivery to the others.
    * **Dead-endpoint cleanup** — vendor 404 / 410 means the
      subscription is permanently invalid; the row MUST be deleted
      so the next fan-out skips it. Keeping zombie rows would
      bloat the per-subject list (B3 settings UI) and waste a vendor
      round-trip per push.
    * **Telemetry without operator-visible side-effects** — every
      delivery emits `start` + `stop` events so the Phase 5 PromEx
      exporter can derive per-subject delivery rate, success ratio,
      and dead-endpoint pruning rate without parsing logs.

  ## API

    * `send_to_subject/2` — fan-out to every subscription for a
      subject; always returns `:ok` (fire-and-forget at the call
      site; per-sub results land in telemetry, not in the return
      value).
    * `send_to_subscription/2` — single-row delivery; returns the
      per-sub result so callers (currently only `send_to_subject/2`'s
      Task fan-out) can inspect it.

  ## Telemetry shape

  Mirrors the `[:grappa, :admission, ...]` event family
  (`Grappa.Admission.Telemetry`):

    * `[:grappa, :push, :send, :start]` — measurements
      `%{count: n_subs}`, metadata `%{subject: Grappa.Subject.t()}`.
      Emitted once per `send_to_subject/2` call, BEFORE fan-out
      begins.
    * `[:grappa, :push, :send, :stop]` — measurements
      `%{success: x, gone: y, error: z, duration_ms: ms}`,
      metadata `%{subject: Grappa.Subject.t(), count: n_subs}`.
      Emitted once per `send_to_subject/2` call AFTER fan-out
      completes.
    * `[:grappa, :push, :delete_dead]` — measurements
      `%{count: n_deleted}`, metadata `%{endpoint: String.t()}`.
      Emitted from `send_to_subscription/2` whenever a 404/410
      response triggers `Push.delete_dead/1`.

  ## Failure handling — no silent drops

  Per `feedback_no_silent_drops_*`: every per-sub failure path emits
  a Logger.warning + telemetry event. NO `try/rescue` swallowing —
  unexpected crashes propagate to the spawned Task and surface in
  SASL crash logs (telemetry-aggregated by Phase 5).

    * `{:ok, _}` from `WebPushElixir.send_notification/2` →
      `Push.touch_last_used/1` + `:ok`.
    * `{:error, :expired}` (vendor 404/410) → `Push.delete_dead/1`
      + telemetry + `{:error, :gone}`.
    * `{:error, {:http_error, status, _body}}` (any other 4xx/5xx)
      → Logger.warning + `{:error, {:http_error, status}}`.
    * Network errors / timeouts surface as a `CaseClauseError`
      raised by the upstream lib (v0.8.0 has an unhandled `case` arm
      for `Req.TransportError`-bearing results) — caught at the
      boundary and mapped to `{:error, {:transport_error, reason}}`.
      A defensible exception to "let it crash" because (a) we cannot
      wait for upstream patch, (b) silent-dropping the network-error
      path violates the no-silent-drops rule, (c) the rescue scope is
      narrow (single library call, single exception class).
    * Encryption failures (malformed P-256 key, base64url decode
      failure on stored `p256dh_key`/`auth_key`, JOSE.JWS sign error
      on a malformed VAPID private key) raise `ArgumentError` /
      `MatchError` from inside the lib BEFORE the HTTP POST. These
      are also caught at the boundary and mapped to
      `{:error, {:encrypt_error, reason}}` — same boundary
      justification as the transport rescue. Server-side data is
      changeset-validated at write time (`Subscription.changeset/2`'s
      length caps), so this branch should never fire in practice; if
      it does, it indicates upstream-lib drift or a stored-data
      corruption that operators MUST see in telemetry.

  ## Boundary

  Lives inside the `Grappa.Push` context boundary (no top-level
  `use Boundary` annotation — same convention as `Push.Subscription`).
  Reachable as `Grappa.Push.Sender.send_to_subject/2` once the Push
  context exports it for B4's trigger hot path.
  """

  alias Grappa.{Push, Subject}
  alias Grappa.Push.Subscription

  require Logger

  @typedoc """
  Push payload shape. The wire shape is typed (atom keys, String.t()
  values), but the values themselves are user-facing strings — the
  documented EXCEPTION to the wire-shape rule per
  `docs/plans/2026-05-14-push-notifications.md` § Standing rules.
  Reason: the OS notification surface (lockscreen, notification
  centre) renders the payload BEFORE cic JS gets a chance to format,
  so cic-side localization is impossible for push.
  """
  @type payload :: %{
          required(:title) => String.t(),
          required(:body) => String.t(),
          required(:tag) => String.t(),
          required(:url) => String.t()
        }

  @typedoc """
  Per-subscription delivery result.
    * `:ok` — vendor returned 200/201/202.
    * `{:error, :gone}` — vendor 404/410; subscription deleted.
    * `{:error, {:http_error, status :: integer()}}` — other 4xx/5xx.
    * `{:error, {:transport_error, reason}}` — network error /
      DNS failure / timeout (caught upstream-lib `CaseClauseError`).
    * `{:error, {:encrypt_error, reason}}` — payload encryption /
      VAPID signing failure (caught at the lib boundary).
  """
  @type sub_result ::
          :ok
          | {:error,
             :gone
             | {:http_error, integer()}
             | {:transport_error, term()}
             | {:encrypt_error, term()}
             | term()}

  @doc """
  Fans out `payload` to every push subscription belonging to `subject`.

  Always returns `:ok` — failure modes land in telemetry + Logger. The
  caller (B4 `Push.Triggers`) is fire-and-forget at the message hot
  path; aggregating per-sub results back to the call site would force
  callers to either ignore them (the current shape, made explicit) or
  block on the slowest vendor.

  Concurrency cap of 4 + 10s timeout matches `Task.async_stream/3`
  defaults for fan-out workloads. Higher concurrency would not improve
  latency much (most subjects have ≤3 devices); lower would serialize
  multi-device delivery unnecessarily.

  Empty subscription list short-circuits to `:ok` without emitting
  start/stop telemetry — emitting a zero-count send_event would just
  generate noise in the per-subject dashboard.
  """
  @spec send_to_subject(Subject.t(), payload()) :: :ok
  def send_to_subject({_, _} = subject, payload) when is_map(payload) do
    case Push.list_for_subject(subject) do
      [] ->
        :ok

      subs ->
        :telemetry.execute(
          [:grappa, :push, :send, :start],
          %{count: length(subs)},
          %{subject: subject}
        )

        started_at = System.monotonic_time(:millisecond)

        results =
          subs
          |> Task.async_stream(
            fn sub -> send_to_subscription(sub, payload) end,
            max_concurrency: 4,
            timeout: 10_000,
            on_timeout: :kill_task
          )
          |> Enum.map(fn
            {:ok, result} -> result
            {:exit, reason} -> {:error, reason}
          end)

        duration_ms = System.monotonic_time(:millisecond) - started_at
        {success, gone, error} = tally(results)

        :telemetry.execute(
          [:grappa, :push, :send, :stop],
          %{success: success, gone: gone, error: error, duration_ms: duration_ms},
          %{subject: subject, count: length(subs)}
        )

        :ok
    end
  end

  @doc """
  Sends `payload` to a single push subscription. See moduledoc for
  the failure taxonomy.

  Encodes `payload` with `Jason` so cic SW receives a parsable JSON
  string. The upstream library's `send_notification/2` accepts the
  subscription as a JSON STRING (not a map) — re-encoding here
  matches that contract while keeping the storage shape (struct) in
  the caller's hands.
  """
  @spec send_to_subscription(Subscription.t(), payload()) :: sub_result()
  def send_to_subscription(%Subscription{} = sub, payload) when is_map(payload) do
    subscription_json =
      Jason.encode!(%{
        endpoint: sub.endpoint,
        keys: %{p256dh: sub.p256dh_key, auth: sub.auth_key}
      })

    message = Jason.encode!(payload)

    case web_push_send(subscription_json, message) do
      {:ok, _} ->
        case Push.touch_last_used(sub) do
          {:ok, _} ->
            :ok

          {:error, changeset} ->
            Logger.warning(
              "push.send touch_last_used failed",
              error: inspect(changeset.errors),
              endpoint: sub.endpoint
            )

            :ok
        end

      {:error, :expired} ->
        {deleted, _} = Push.delete_dead(sub.endpoint)

        :telemetry.execute(
          [:grappa, :push, :delete_dead],
          %{count: deleted},
          %{endpoint: sub.endpoint}
        )

        Logger.info(
          "push.send subscription gone — deleted",
          endpoint: sub.endpoint,
          count: deleted
        )

        {:error, :gone}

      {:error, {:http_error, status, _}} ->
        Logger.warning(
          "push.send http error",
          status: status,
          endpoint: sub.endpoint
        )

        {:error, {:http_error, status}}

      {:error, reason} ->
        Logger.warning(
          "push.send failed",
          error: inspect(reason),
          endpoint: sub.endpoint
        )

        {:error, reason}
    end
  end

  # Indirection for testability — Bypass-backed tests override the
  # subscription endpoint URL but cannot easily reach the upstream
  # library's `Application.get_env(:web_push_elixir, ...)` config
  # mid-test. The real implementation calls into the library; tests
  # that want to stub the HTTP layer can use Bypass against the
  # endpoint URL embedded in the subscription itself (the lib reads
  # endpoint from the JSON, not from app env).
  #
  # Defensive rescue: `WebPushElixir.send_notification/2` (v0.8.0)
  # has an unhandled `case` arm for `Req.TransportError`-bearing
  # results — connection refused, timeout, DNS failures, etc. all
  # raise `CaseClauseError` instead of returning `{:error, _}`. The
  # encryption preamble (`Base.url_decode64!` on stored
  # `p256dh_key`/`auth_key`, `:crypto.compute_key` on the P-256
  # point, JOSE.JWS sign on the VAPID private key) raises
  # `ArgumentError` / `MatchError` on malformed inputs. We cannot
  # wait for upstream patches and silent-dropping any of these
  # paths violates the no-silent-drops rule. The rescue scope is
  # narrowed to the direct lib call so any genuine programmer error
  # in our own code (changeset, JSON encoding) still propagates
  # cleanly — and unrecognized `CaseClauseError` shapes get a
  # Logger.error breadcrumb before the reraise so future-Claude
  # debugging an upstream-lib v0.9 shape change has a starting point.
  defp web_push_send(subscription_json, message) do
    WebPushElixir.send_notification(subscription_json, message)
  rescue
    e in CaseClauseError ->
      case e.term do
        {%Req.Request{}, %Req.TransportError{reason: reason}} ->
          {:error, {:transport_error, reason}}

        other ->
          Logger.error(
            "push.send unexpected upstream lib shape — reraising",
            error: inspect(other)
          )

          reraise e, __STACKTRACE__
      end

    e in [ArgumentError, MatchError, ErlangError] ->
      {:error, {:encrypt_error, Exception.message(e)}}
  end

  defp tally(results) do
    Enum.reduce(results, {0, 0, 0}, fn
      :ok, {s, g, e} -> {s + 1, g, e}
      {:error, :gone}, {s, g, e} -> {s, g + 1, e}
      {:error, _}, {s, g, e} -> {s, g, e + 1}
    end)
  end
end
