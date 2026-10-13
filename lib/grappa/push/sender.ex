defmodule Grappa.Push.Sender do
  @moduledoc """
  Web Push delivery — sends VAPID-signed encrypted payloads to every
  push subscription belonging to a subject.

  Push notifications cluster B2 (2026-05-14). Sits between the trigger
  hot path (B4 — `Grappa.Push.Triggers`) and the push services, owning
  the fan-out, the endpoint address policy, the POST itself,
  dead-endpoint cleanup, and telemetry emission. The upstream `ExNudge`
  library supplies the RFC 8291 encryption and the RFC 8292 VAPID
  signature; since #2401 it no longer sends anything.

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

  ## Why the sender owns the POST (#2401)

  An endpoint is a URL a client chose, so delivering to it is an
  outbound request the client aimed. Every delivery resolves the
  endpoint's host through `Grappa.Net.Ssrf.resolve_safe/1` and dials the
  address that answered — loopback, private, link-local and metadata
  ranges are refused before any byte leaves — while `Host`, SNI and the
  certificate check keep the original name. Checking a name and then
  letting the HTTP client resolve it again would leave a window a
  rebinding name can win; dialling the checked address closes it — on a
  connection of its own, through `Grappa.Net.PinnedHttp`. Redirects
  are never followed. `ExNudge.send_notification/3` hands the endpoint to
  `HTTPoison.post/3` with no options, so none of this can be asked of it.
  A refused row is kept and logged, never swept — see `deliver/2`'s caller.

  ## What else the wrapper owns

  Four concerns B4 callers MUST NOT have to repeat at every call site:

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
    * **The return-shape mapping** — `post/4` below turns a vendor
      response into the closed `t:sub_result/0` set. See its comment
      for why 404 sweeps.

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
  need it. The sibling `push.send subscription gone — deleted` already
  sits at `info` for the same class of event.

  The volume is set by the subject's PREFS, and it is worth stating
  honestly rather than waving at. A delivery needs a message that passes
  `Push.Triggers.should_notify?/5` AND no device with the PWA
  on-screen. Under the defaults (`channel_messages_all: false`,
  `channel_mentions: true`, `private_messages_all: true`) that means a
  DM or a mention, so the line is rare. An operator who turns
  `channel_messages_all` ON has asked for a notification per channel
  message, and gets one line per message per registered device to
  match — the pref sets the rate, and `LOG_LEVEL` is the knob if the
  consequence is unwanted.

  Success TELEMETRY is deliberately NOT added: the fan-out's
  `[:grappa, :push, :send, :stop]` already carries `success:` (see
  "Telemetry shape"), and a per-subscription success counter would
  restate a number the aggregate already has.

  ### The endpoint on the line, at this frequency

  `endpoint:` is the full vendor URL, which is a CAPABILITY: holding it
  lets anyone POST to that device (they cannot decrypt without the
  subscription's keys, but they can burn its quota). It already rode all
  four failure arms of this function; what changes here is FREQUENCY —
  from broken subscriptions only to every successful delivery — and
  stdout persists across restarts and ships out with any log forwarder.

  Taken deliberately, and the alternatives were the reason. `Push.VendorLog`
  logs the HOST alone under `:vendor` (#1321, "a path segment can itself
  be a credential") and can afford to, because its own moduledoc points
  at THIS module's line as the correlation anchor; host-only here would
  leave nothing to anchor to, and could not tell two iPhones on
  `web.push.apple.com` apart, which is exactly the multi-device case the
  line exists for. A non-capability handle — the subscription row id —
  would need a new Logger metadata key, and any `config/*.exs` edit
  turns a hot deploy cold. So: named, not hidden. If the exposure is
  judged to outweigh the correlation, the cure is `:vendor` here too and
  a subscription id once some other change is already paying for a cold
  deploy.

  ## Failure handling — no silent drops

  Per `feedback_no_silent_drops_*`: every per-sub failure path emits
  a Logger.warning + telemetry event. NO `try/rescue` swallowing —
  unexpected crashes propagate to the spawned Task and surface in
  SASL crash logs (telemetry-aggregated by Phase 5).

  Every outcome lands on the closed set documented on
  `t:sub_result/0`, so the taxonomy below is the whole contract and no
  caller sees a library atom:

    * vendor 2xx → `Push.touch_last_used/1` + `:ok`.
    * vendor 404 **or** 410 → `Push.delete_dead/1` + telemetry +
      `{:error, :gone}`.
    * any other non-2xx, a redirect included → Logger.warning + the
      `[:grappa, :push, :vendor_rejection]` event `Grappa.Push.VendorLog`
      turns into the vendor's own reason + `{:error, {:http_error, status}}`.
    * endpoint not `http(s)`, or its host not a public address →
      Logger.warning + `{:error, :ssrf_blocked}`; the row is kept.
    * network error / DNS failure / timeout →
      `{:error, {:transport_error, reason}}`.
    * encryption or VAPID-signing failure →
      `{:error, {:encrypt_error, reason}}`. Server-side data is
      changeset-validated at write time (`Subscription.changeset/2`'s
      length caps), so this should never fire in practice; if it does
      it indicates upstream-lib drift or stored-data corruption that
      operators MUST see in telemetry.

  A narrow `rescue` still guards the library crypto calls:
  `ExNudge.VAPID.sign_jwt/2` runs JOSE unguarded and a malformed VAPID
  private key raises there, BEFORE the POST. Scope is those calls and
  the same three exception classes as before — silent-dropping that
  path would violate the no-silent-drops rule.

  ## Boundary

  Lives inside the `Grappa.Push` context boundary (no top-level
  `use Boundary` annotation — same convention as `Push.Subscription`).
  Reachable as `Grappa.Push.Sender.send_to_subject/2` once the Push
  context exports it for B4's trigger hot path.
  """

  alias ExNudge.{Encryption, VAPID}
  alias Grappa.Net.{PinnedHttp, Ssrf}
  alias Grappa.{Push, Subject}
  alias Grappa.Push.Subscription

  require Logger

  # Injected SSRF resolver (#2401) — module exposing `resolve_safe/1`. The
  # real guard in prod/dev; `config/test.exs` swaps in
  # `Grappa.Net.Ssrf.TestResolver` so Bypass on loopback is reachable while
  # every other range stays blocked. The `Grappa.Net.ImageFetcher.Req` seam.
  @resolver Application.compile_env(:grappa, [:push, :ssrf_resolver], Ssrf)

  # Inside `send_to_subject/2`'s 10 s per-subscription Task budget together
  # with the resolve (`Grappa.Net.Ssrf`'s two bounded lookups), so a stalled
  # vendor or resolver reports its own timeout instead of being killed
  # mid-request by the fan-out with nothing logged. A push service answers
  # with an empty 201 or a short error document; the body cap is what keeps
  # an error PAGE from being buffered whole.
  @http_opts [connect_timeout: 2_000, deadline: 3_000, max_body: 64 * 1024]

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
    * `{:error, :ssrf_blocked}` — endpoint not `http(s)`, or its host
      not a public address (#2401); row kept.
    * `{:error, {:transport_error, reason}}` — network error /
      DNS failure / timeout.
    * `{:error, {:encrypt_error, reason}}` — payload encryption /
      VAPID signing failure (caught at the lib boundary).
  """
  @type sub_result ::
          :ok
          | {:error,
             :gone
             | :ssrf_blocked
             | {:http_error, integer()}
             | {:transport_error, term()}
             | {:encrypt_error, term()}}

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
  string. The two key columns reach `ExNudge.Encryption` unchanged:
  both are base64url exactly as `PushManager.subscribe()` produced
  them, which is why the switch to RFC 8291 needs no re-subscription
  on our side of the wire.

  Provider-agnostic on purpose — see moduledoc "`:provider`
  (2026-08-13, UnifiedPush)" for why a UnifiedPush row goes through
  this exact same encrypted path unchanged.
  """
  @spec send_to_subscription(Subscription.t(), payload()) :: sub_result()
  def send_to_subscription(%Subscription{} = sub, payload) when is_map(payload) do
    message = Jason.encode!(payload)

    case deliver(sub, message) do
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
        sweep_dead(sub)
        {:error, :gone}

      {:error, :ssrf_blocked} ->
        # #2401 — refused, NOT swept. The verdict comes from a DNS answer,
        # and a DNS answer is the one input here that neither we nor the
        # vendor control: deleting on it would let a resolver hiccup wipe
        # every device a subject registered. The row stays, every delivery
        # re-asks, and every refusal says so.
        Logger.warning(
          "push.send endpoint refused — not an http(s) URL on a public address",
          endpoint: sub.endpoint
        )

        {:error, :ssrf_blocked}

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

  # #590 — `delete_dead/1` degrades a sustained SQLITE_BUSY to
  # `{:error, :db_unavailable}`. This is a background delivery task with no
  # client waiting, so the terminal is best-effort DROP: log + carry on —
  # the stale endpoint is swept on the next failed delivery. Either way the
  # subscription is treated as gone from this delivery's perspective.
  @spec sweep_dead(Subscription.t()) :: :ok
  defp sweep_dead(%Subscription{endpoint: endpoint}) do
    case Push.delete_dead(endpoint) do
      {deleted, nil} ->
        :telemetry.execute([:grappa, :push, :delete_dead], %{count: deleted}, %{endpoint: endpoint})
        Logger.info("push.send subscription gone — deleted", endpoint: endpoint, count: deleted)

      {:error, :db_unavailable} ->
        Logger.warning(
          "push.send: dead-subscription sweep deferred — db unavailable",
          endpoint: endpoint
        )
    end
  end

  # #2401 — the delivery is OURS from the address check to the response,
  # because the check is only worth what the connection honours. The
  # endpoint's host goes through `Grappa.Net.Ssrf.resolve_safe/1` on EVERY
  # delivery, and the POST dials the address that answered, with the
  # original host kept for `Host`, SNI and the certificate check: a name
  # that resolves publicly for the check and privately a moment later has
  # no second lookup to win. `ExNudge.send_notification/3` cannot do this —
  # it hands the endpoint string to `HTTPoison.post/3` with no options, so
  # the client resolves the name itself. What stays the library's is the
  # crypto (`ExNudge.Encryption`, `ExNudge.VAPID`); the wire shape that
  # crypto feeds is pinned by `Grappa.Push.WireFormatTest`.
  #
  # A redirect is NOT followed: it would be a second hop to a URL nobody
  # checked. A push service answers 201; a 3xx is reported as the http
  # error it is.
  @spec deliver(Subscription.t(), String.t()) :: sub_result()
  defp deliver(%Subscription{endpoint: endpoint} = sub, message) do
    with {:ok, uri} <- parse_endpoint(endpoint),
         {:ok, ip} <- resolve(uri.host),
         {:ok, body, jwt} <- encrypt_and_sign(sub, message) do
      post(uri, ip, jwt, body)
    end
  end

  # `http` survives here for rows saved before #2401 and for the Bypass
  # suites; the changeset admits `https` alone. The ADDRESS is what makes
  # a request safe to send, and it is checked below whatever the scheme.
  defp parse_endpoint(endpoint) do
    case URI.parse(endpoint) do
      %URI{scheme: scheme, host: host} = uri
      when scheme in ["http", "https"] and is_binary(host) and host != "" ->
        {:ok, uri}

      _ ->
        {:error, :ssrf_blocked}
    end
  end

  defp resolve(host) do
    case @resolver.resolve_safe(host) do
      {:ok, ip} -> {:ok, ip}
      {:error, :ssrf_blocked} -> {:error, :ssrf_blocked}
      {:error, :dns_error} -> {:error, {:transport_error, :dns_error}}
    end
  end

  # The narrow rescue survives the transport swap, scoped to the library
  # calls alone: `ExNudge.VAPID.sign_jwt/2` runs `JOSE.JWK.from_key/1` +
  # `JOSE.JWS.compact/1` unguarded, so a malformed VAPID private key raises
  # rather than returning, and silent-dropping that path would violate the
  # no-silent-drops rule. A genuine programmer error in our own code
  # (changeset, JSON encoding, the POST) still propagates cleanly.
  #
  # `ExNudge.Encryption.encrypt/2`'s `@spec` promises `{:error, atom()}`,
  # but it also returns `{:invalid_ecdh_key, _}`-shaped tuples — measured
  # by the malformed-P-256 test — so the error arm takes any reason.
  @dialyzer {:nowarn_function, encrypt_and_sign: 2}
  @spec encrypt_and_sign(Subscription.t(), String.t()) ::
          {:ok, binary(), String.t()} | {:error, {:encrypt_error, term()}}
  defp encrypt_and_sign(%Subscription{} = sub, message) do
    with {:ok, keys} <- VAPID.get_keys(),
         {:ok, %{ciphertext: body}} <-
           Encryption.encrypt(message, %{p256dh: sub.p256dh_key, auth: sub.auth_key}),
         {:ok, jwt} <- VAPID.sign_jwt(sub.endpoint, keys) do
      {:ok, body, jwt}
    else
      {:error, reason} -> {:error, {:encrypt_error, reason}}
    end
  rescue
    e in [ArgumentError, MatchError, ErlangError] ->
      {:error, {:encrypt_error, Exception.message(e)}}
  end

  # RFC 8291 + RFC 8292 headers — the shape the moduledoc describes.
  # `TTL: 60` is what `ExNudge` sent by default; it is ours now and stays.
  #
  # **404 is terminal, exactly like 410** (RFC 8030 §7.3: a push resource
  # that no longer exists is gone for good, not a transient failure).
  # Getting this wrong is not a missing SIGNAL — the catch-all still logs
  # and emits telemetry — it is a missing SWEEP: the row is never deleted
  # and every future fan-out pays a vendor round-trip for a subscription
  # that can never be delivered again. Payload-too-large (413) is
  # deliberately NOT terminal: the subscription is fine, our payload was
  # too big, so it reports as the plain HTTP error it is.
  defp post(%URI{} = uri, ip, jwt, body) do
    headers = [
      {"authorization", "vapid t=#{jwt},k=#{Push.vapid_public_key()}"},
      {"content-encoding", Push.content_encoding()},
      {"content-type", "application/octet-stream"},
      {"ttl", "60"}
    ]

    case PinnedHttp.request("POST", uri, ip, headers, body, @http_opts) do
      {:ok, %{status: status}} when status in 200..299 ->
        :ok

      {:ok, %{status: status}} when status in [404, 410] ->
        {:error, :gone}

      {:ok, %{status: status, body: vendor_body}} ->
        report_rejection(uri, status, vendor_body)
        {:error, {:http_error, status}}

      {:error, {:transport, reason}} ->
        {:error, {:transport_error, reason}}

      {:error, reason} ->
        {:error, {:transport_error, reason}}
    end
  end

  # #1321 — the vendor's own words on a rejection, for `Grappa.Push.VendorLog`.
  # A terminal 404/410 is not reported: the sweep already logs it, and an
  # expired subscription needs no diagnosis. The host alone crosses: a path
  # segment can itself be a credential.
  defp report_rejection(%URI{host: host}, status, body) do
    :telemetry.execute(
      [:grappa, :push, :vendor_rejection],
      %{},
      %{status: status, vendor: host, body: body}
    )
  end

  defp tally(results) do
    Enum.reduce(results, {0, 0, 0}, fn
      :ok, {s, g, e} -> {s + 1, g, e}
      {:error, :gone}, {s, g, e} -> {s, g + 1, e}
      {:error, _}, {s, g, e} -> {s, g, e + 1}
    end)
  end
end
