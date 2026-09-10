defmodule Grappa.Push.Sender do
  @moduledoc """
  Web Push delivery — sends VAPID-signed encrypted payloads to every
  push subscription belonging to a subject.

  Push notifications cluster B2 (2026-05-14). Sits between the trigger
  hot path (B4 — `Grappa.Push.Triggers`) and the upstream `ExNudge`
  library, owning the fan-out, dead-endpoint cleanup, the return-shape
  adapter, and telemetry emission.

  ## `:provider` (2026-08-13, UnifiedPush)

  A subscription's `:provider` field (`Ecto.Enum` — `:webpush` |
  `:unifiedpush`) distinguishes how the ROW WAS REGISTERED — a browser's
  Push API vs. an Android UnifiedPush distributor — for display purposes
  (the device-list UX) and for the client-side registration flow. It does
  NOT branch delivery here: a UnifiedPush registration carries a real
  P-256 keypair + auth secret too, generated client-side the same way
  a browser's `PushManager.subscribe()` does internally.
  `send_to_subscription/2` reads no branch on `:provider` at all.

  ## What we put on the wire — RFC 8291 + RFC 8292 (#1290, 2026-08-14)

  A POST here carries:

    * `content-encoding: aes128gcm` — the RFC 8188 content coding
      mandated by RFC 8291, with the 16-byte salt, the record size,
      and the server's ephemeral P-256 public key (`keyid`) in the
      BODY's own binary header, ahead of the ciphertext.
    * `authorization: vapid t=<jwt>, k=<base64url public key>` — the
      RFC 8292 scheme.
    * No `encryption:` and no `crypto-key: dh=` header. There is
      nothing left to put in them.

  Until this issue landed we emitted the superseded drafts —
  `aesgcm` (draft-ietf-webpush-encryption-04) with the salt and the
  server key in HEADERS, and `Authorization: WebPush <jwt>`
  (draft-ietf-webpush-vapid-01). The gap was structural, not
  cosmetic: those two header values are mandatory HKDF inputs, so a
  transport that does not preserve headers handed the application a
  body it could not decrypt no matter how correct its key material
  was. UnifiedPush discards headers by design, which is where the
  breakage was first reported (by the Resentin author — theirs, not
  measured here). Browser push kept working only because the big
  push services still accept a draft they superseded, and that
  tolerance is theirs to withdraw, not ours to rely on.

  `Grappa.Push.content_encoding/0` is the single source of truth for
  the coding name and is what `GET /api/config` publishes, so a
  third-party client can ASK whether this server speaks RFC 8291
  instead of inferring it from the release string.
  `test/grappa/push/wire_format_test.exs` pins the whole shape —
  headers, the body header block, and a decrypt performed with
  nothing but the subscription's own `p256dh`/`auth` — so a
  dependency bump cannot quietly walk it back.

  ## Subject-scoped — V3 (2026-05-15)

  Both registered users and visitors own push subscriptions; the
  `send_to_subject/2` API takes a `Grappa.Subject.t()` tagged tuple
  and fans out across every row matching that subject FK column.

  ## Why a thin wrapper instead of inlining `ExNudge`

  Four concerns the upstream lib doesn't cover and B4 callers MUST
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
    * **The return-shape adapter** — `deliver/2` below is the ONLY
      place that knows `ExNudge`'s vocabulary. See its comment for
      the mapping and for why 404 sweeps.

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

  ## What the operator reads (issue 2067)

  Every terminal of `send_to_subscription/2` says something, the
  DELIVERED one included. It did not until issue 2067: the vendor-2xx
  arm returned without a line while every OTHER arm of the same `case`
  logged, so an empty `journalctl -u grappa | grep push` was equally
  consistent with "delivered fine" and "the sender was never called".
  That ambiguity cost an evening of live debugging with a self-hoster
  whose pushes were in fact being delivered — the silence was the bug.

  `info`, not `debug`, and the level is the decision rather than a
  detail. `debug` is below the level this ships at (`config/prod.exs`
  pins `:info`; `config/runtime.exs` defaults `LOG_LEVEL` to the same),
  so it would leave the operator's question ("did you try to send it or
  not?") answered exactly as badly as before for anyone who has not
  already reconfigured the logger — which is nobody, at the moment they
  need it. The volume it buys is bounded by construction: a delivery
  happens only when a message passes `Push.Triggers.should_notify?/5`
  AND no device of that subject has the PWA on-screen, so the line is
  one per notification per registered device, not one per IRC message.
  The sibling `push.send subscription gone — deleted` already sits at
  `info` for the same class of event.

  Success TELEMETRY is deliberately NOT added: the fan-out's
  `[:grappa, :push, :send, :stop]` already carries `success:` (see
  "Telemetry shape"), and a per-subscription success counter would
  restate a number the aggregate already has.

  ## Failure handling — no silent drops

  Per `feedback_no_silent_drops_*`: every per-sub failure path emits
  a Logger.warning + telemetry event. NO `try/rescue` swallowing —
  unexpected crashes propagate to the spawned Task and surface in
  SASL crash logs (telemetry-aggregated by Phase 5).

  `deliver/2` normalizes every `ExNudge` shape onto the closed set
  documented on `t:sub_result/0`, so the taxonomy below is the whole
  contract and no caller sees a library atom:

    * vendor 2xx → `Push.touch_last_used/1` + `:ok`.
    * vendor 404 **or** 410 → `Push.delete_dead/1` + telemetry +
      `{:error, :gone}`.
    * any other 4xx/5xx → Logger.warning +
      `{:error, {:http_error, status}}`.
    * network error / DNS failure / timeout →
      `{:error, {:transport_error, reason}}`.
    * encryption or VAPID-signing failure →
      `{:error, {:encrypt_error, reason}}`. Server-side data is
      changeset-validated at write time (`Subscription.changeset/2`'s
      length caps), so this should never fire in practice; if it does
      it indicates upstream-lib drift or stored-data corruption that
      operators MUST see in telemetry.

  A narrow `rescue` still guards the lib call. `ExNudge` RETURNS its
  encryption and transport errors rather than raising (its
  `HTTPoison.post/3` case covers both of that function's return
  shapes, so the `CaseClauseError` arm the previous dependency needed
  is gone), but `ExNudge.VAPID.sign_jwt/2` runs JOSE unguarded and a
  malformed VAPID private key raises there, BEFORE the POST. Scope is
  the single library call and the same three exception classes as
  before — silent-dropping that path would violate the
  no-silent-drops rule.

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
  the push-payload standing rules.
  Reason: the OS notification surface (lockscreen, notification
  centre) renders the payload BEFORE cic JS gets a chance to format,
  so cic-side localization is impossible for push.
  """
  @type payload :: %{
          required(:title) => String.t(),
          required(:body) => String.t(),
          required(:tag) => String.t(),
          required(:url) => String.t(),
          optional(:badge) => non_neg_integer()
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
  string, and restates our stored row as an `ExNudge.Subscription`
  struct — the library's own input shape. The two key columns cross
  unchanged: both are base64url exactly as `PushManager.subscribe()`
  produced them, which is why the switch to RFC 8291 needs no
  re-subscription on our side of the wire.

  Provider-agnostic on purpose — see moduledoc "`:provider`
  (2026-08-13, UnifiedPush)" for why a UnifiedPush row goes through
  this exact same encrypted path unchanged.
  """
  @spec send_to_subscription(Subscription.t(), payload()) :: sub_result()
  def send_to_subscription(%Subscription{} = sub, payload) when is_map(payload) do
    ex_nudge_subscription = %ExNudge.Subscription{
      endpoint: sub.endpoint,
      keys: %{p256dh: sub.p256dh_key, auth: sub.auth_key}
    }

    message = Jason.encode!(payload)

    case deliver(ex_nudge_subscription, message) do
      :ok ->
        # issue 2067 — the one terminal that used to say nothing. Logged
        # BEFORE `touch_last_used/1` because the fact being reported is the
        # vendor 2xx, which has already happened: putting it in the `{:ok,
        # _}` sub-arm would make a failed row-bump erase the record of a
        # delivery that did occur, and the warning below would then be the
        # only trace of a SUCCESSFUL send.
        Logger.info("push.send delivered", endpoint: sub.endpoint)

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

      {:error, :gone} ->
        # #590 — `delete_dead/1` degrades a sustained SQLITE_BUSY to
        # `{:error, :db_unavailable}`. This is a background delivery task with no
        # client waiting, so the terminal is best-effort DROP: log + carry on —
        # the stale endpoint is swept on the next failed delivery. Either way the
        # subscription is treated as gone from this delivery's perspective.
        case Push.delete_dead(sub.endpoint) do
          {deleted, nil} ->
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

          {:error, :db_unavailable} ->
            Logger.warning(
              "push.send: dead-subscription sweep deferred — db unavailable",
              endpoint: sub.endpoint
            )
        end

        {:error, :gone}

      {:error, {:http_error, status}} ->
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

  # The ONE place that speaks `ExNudge`'s vocabulary (#1290). Its
  # three return shapes all differ from the ones this module used to
  # match, so without this adapter every non-2xx path would fall to
  # the catch-all and the dead-subscription sweep would be lost —
  # measured on the issue before the swap, not discovered after.
  #
  #   `{:error, :subscription_expired}`  (410) → `{:error, :gone}`
  #   `{:error, {:http_error, 404}}`           → `{:error, :gone}`
  #   `{:error, {:http_error, status}}`        → same, our 2-tuple
  #   `{:error, {:request_failed, reason}}`    → `{:error, {:transport_error, reason}}`
  #   encryption / VAPID errors                → `{:error, {:encrypt_error, reason}}`
  #
  # **404 is terminal, exactly like 410** (RFC 8030 §7.3: a push
  # resource that no longer exists is gone for good, not a transient
  # failure). `ex_nudge` maps only 410 natively, so the terminality of
  # 404 is OUR rule and lives here. Getting this wrong is not a
  # missing SIGNAL — the catch-all still logs and emits telemetry —
  # it is a missing SWEEP: the row is never deleted and every future
  # fan-out pays a vendor round-trip for a subscription that can
  # never be delivered again.
  #
  # Payload-too-large (413) is deliberately NOT terminal: the
  # subscription is fine, our payload was too big, so it reports as
  # the plain HTTP error it is and the row survives.
  #
  # The rescue survives the swap in narrowed form. `ExNudge` returns
  # its encryption and transport errors, but `ExNudge.VAPID.sign_jwt/2`
  # runs `JOSE.JWK.from_key/1` + `JOSE.JWS.compact/1` unguarded, so a
  # malformed VAPID private key still raises before the POST. Scope is
  # the single library call, so a genuine programmer error in our own
  # code (changeset, JSON encoding) still propagates cleanly.
  @spec deliver(ExNudge.Subscription.t(), String.t()) :: sub_result()
  defp deliver(%ExNudge.Subscription{} = subscription, message) do
    subscription
    |> ExNudge.send_notification(message, [])
    |> normalize()
  rescue
    e in [ArgumentError, MatchError, ErlangError] ->
      {:error, {:encrypt_error, Exception.message(e)}}
  end

  # `ExNudge`'s declared types are narrower than what it returns, so
  # Dialyzer calls the encryption clause below unreachable. It is not:
  # removing it turns the malformed-P-256 test red with
  # `{:error, {:invalid_ecdh_key, ~c"Can't do fromdata"}}` — measured by
  # mutation, not argued. `ExNudge.known_error/0` (`ex_nudge.ex:43-47`)
  # simply omits the three tuples `encryption.ex:70,73,130` produces.
  #
  # The sibling defect is already worked around rather than silenced:
  # the arity-2 `@spec` at `ex_nudge.ex:49` promises `{:error, atom()}`,
  # contradicting the arity-3 spec at `:70` AND the code, which is why
  # `deliver/2` calls the 3-arity form with an explicit `[]`. That fixed
  # three of the four warnings honestly; this one has no honest fix on
  # our side of the boundary.
  @dialyzer {:nowarn_function, normalize: 1}
  @spec normalize(ExNudge.send_result()) :: sub_result()
  defp normalize({:ok, _}), do: :ok
  defp normalize({:error, :subscription_expired}), do: {:error, :gone}
  defp normalize({:error, {:http_error, status}}) when status in [404, 410], do: {:error, :gone}
  defp normalize({:error, {:http_error, status}}), do: {:error, {:http_error, status}}
  defp normalize({:error, :payload_too_large}), do: {:error, {:http_error, 413}}
  defp normalize({:error, {:request_failed, reason}}), do: {:error, {:transport_error, reason}}

  defp normalize({:error, reason})
       when reason in [:missing_vapid_keys, :invalid_base64, :invalid_input],
       do: {:error, {:encrypt_error, reason}}

  defp normalize({:error, {kind, _} = reason})
       when kind in [:invalid_ecdh_key, :ecdh_failed, :aes_encryption_failed],
       do: {:error, {:encrypt_error, reason}}

  # An `ExNudge` shape we have never seen. Passes through to the
  # caller's catch-all (which logs + tallies it as an error), with an
  # `error:` breadcrumb naming the adapter so the next reader knows a
  # dependency bump moved the vocabulary rather than hunting a bug in
  # the delivery path.
  defp normalize({:error, reason}) do
    Logger.error(
      "push.send unexpected upstream lib shape — adapter has no clause",
      error: inspect(reason)
    )

    {:error, reason}
  end

  defp tally(results) do
    Enum.reduce(results, {0, 0, 0}, fn
      :ok, {s, g, e} -> {s + 1, g, e}
      {:error, :gone}, {s, g, e} -> {s, g + 1, e}
      {:error, _}, {s, g, e} -> {s, g, e + 1}
    end)
  end
end
