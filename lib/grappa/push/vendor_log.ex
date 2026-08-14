defmodule Grappa.Push.VendorLog do
  @moduledoc """
  Records what a push service SAID when it rejected a delivery (#1321).

  `Grappa.Push.Sender` logs the HTTP status of a rejected push and
  nothing else, because the status is all it is given. A bare `400` or
  `403` is indistinguishable from a bad JWT, a stale application server
  key, a clock skew or an expired subscription — the services write the
  actual reason into the response BODY, and the diagnosis is one field
  long once you can read it.

  ## Why a telemetry sink instead of plumbing it through the sender

  There is no plumbing route. `ExNudge.send_notification/3` binds the
  `%HTTPoison.Response{}` on the failure branch and returns
  `{:error, {:http_error, status}}` — the response never leaves the
  library (its own `@spec` for `send_notifications/3` promises a
  response it does not hand back; `Grappa.Push.Sender` already documents
  that the declared types are narrower than the returns).

  The body IS reachable, by exactly one route: the library's
  `[:ex_nudge, :send_notification]` telemetry event carries the response
  body as `metadata.error_reason` whenever the response was a non-2xx it
  did not classify itself. So this module attaches there.

  Consequences of that route, both deliberate:

    * **`retry-after` is unreachable.** Response HEADERS never leave
      `ExNudge` by any route, telemetry included. The issue asks for it;
      it cannot be had without a change upstream, and the last release is
      1.0.2 (2025-07-28).
    * **Terminal and transport failures stay silent here.** The library
      classifies 410 / 413 and transport errors itself and passes an atom
      in place of a response, so the event carries a nil
      `http_status_code` and no body. Those paths already log at the
      sender with everything there is to say; a second line would add
      noise, not information. An integer `http_status_code` is therefore
      the exact discriminator for "a vendor body exists", and this
      handler keys on it.

  ## What the line may contain

  Per the maintainer's ruling on #1323 the reason string is for human
  diagnosis ONLY: no code matches on it, subscriptions keep being swept
  on 404 / 410 alone, and a 400 sweeps nothing whatever reason it
  carries.

  Two rules constrain what reaches stdout, which persists across
  restarts and ships out with any log forwarder:

    * **The host, never the path.** The line records the endpoint's host
      alone, because a path segment can itself be a credential. Operators
      correlate with the sender's own `push.send http error` line, which
      is emitted for the same delivery.
    * **The body is capped** (`@max_reason_bytes`) and folded onto one
      line. It is vendor text of unbounded size and arbitrary bytes;
      the cap is what keeps an error PAGE from becoming a log flood, and
      the fold is what keeps the line greppable.

  ## Restart strategy / test isolation

  `:permanent` singleton (registered as `__MODULE__`) holding no state:
  it owns nothing but its own telemetry attachment, which `init/1`
  re-establishes on every restart. The handler logs synchronously in the
  emitting process — unlike the sinks it is modelled on
  (`Grappa.SessionLog`, `Grappa.DbLatency`) it does no Repo or ETS work,
  so there is nothing to move off the caller, and a delivery Task is not
  a hot path. Boots with `attach_telemetry: false` in test env
  (`config/test.exs`), so tests attach the handler explicitly instead of
  folding every suite's push telemetry into the shared Logger stream.
  """

  use GenServer

  require Logger

  @handler_id "grappa-push-vendor-log"
  @event [:ex_nudge, :send_notification]

  # Genuine config default (correct production behavior): these are small
  # error documents — a couple of hundred bytes is the whole reason, and
  # anything past it is a vendor error page, not a diagnosis.
  @max_reason_bytes 256

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  @impl GenServer
  def init(opts) do
    if Keyword.get(opts, :attach_telemetry, true) do
      # Detach-then-attach so a brutal_kill restart (terminate/2 never
      # runs) doesn't leave a stale handler bound to a dead pid. Detach
      # of an unknown id is `:ok`, so this is safe on first boot too.
      _ = :telemetry.detach(@handler_id)

      :ok = :telemetry.attach(@handler_id, @event, &__MODULE__.handle_telemetry/4, nil)
    end

    # No state: the attachment is the whole job.
    {:ok, nil}
  end

  @impl GenServer
  def terminate(_, _) do
    :ok = :telemetry.detach(@handler_id)
  end

  @doc false
  # Runs in the EMITTER's process (per :telemetry semantics) — the
  # `Grappa.Push.Sender` fan-out Task, never a hot path.
  @spec handle_telemetry([atom()], map(), map(), term()) :: :ok
  def handle_telemetry(_, _, %{status: :error, http_status_code: status} = metadata, _)
      when is_integer(status) do
    Logger.warning("push.vendor rejected",
      status: status,
      vendor: host(Map.get(metadata, :endpoint)),
      reason: reason(Map.get(metadata, :error_reason))
    )
  end

  def handle_telemetry(_, _, _, _), do: :ok

  # The endpoint's host and nothing else — a path segment can itself be
  # a credential. `ExNudge` hands over an endpoint it has already
  # partially masked; this does not rely on that.
  @spec host(term()) :: String.t()
  defp host(endpoint) when is_binary(endpoint) do
    case URI.parse(endpoint) do
      %URI{host: host} when is_binary(host) -> host
      _ -> "unknown"
    end
  end

  defp host(_), do: "unknown"

  # A body is what an integer `http_status_code` implies, but the library's
  # declared types are already known to be narrower than what it returns
  # (see `Grappa.Push.Sender.normalize/1`), so a non-binary reason is
  # reported rather than crashed on.
  @spec reason(term()) :: String.t()
  defp reason(body) when is_binary(body), do: body |> cap() |> one_line()
  defp reason(other), do: inspect(other)

  @spec cap(binary()) :: binary()
  defp cap(body) when byte_size(body) <= @max_reason_bytes, do: body
  defp cap(body), do: binary_slice(body, 0, @max_reason_bytes) <> " …(truncated)"

  # Vendor bytes, not a string: `cap/1` can cut mid-codepoint and the body
  # may not be UTF-8 at all, so make it valid BEFORE folding the
  # whitespace — one Logger line stays greppable.
  @spec one_line(binary()) :: String.t()
  defp one_line(text) do
    text
    |> String.replace_invalid()
    |> String.replace(~r/\s+/u, " ")
    |> String.trim()
  end
end
