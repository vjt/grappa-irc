defmodule Grappa.Push.VendorLog do
  @moduledoc """
  Records what a push service SAID when it rejected a delivery (#1321).

  `Grappa.Push.Sender`'s own line for a rejected push carries the HTTP
  status and nothing else. A bare `400` or
  `403` is indistinguishable from a bad JWT, a stale application server
  key, a clock skew or an expired subscription — the services write the
  actual reason into the response BODY, and the diagnosis is one field
  long once you can read it.

  ## Where the body comes from

  `Grappa.Push.Sender` owns the POST since #2401 (it has to: the endpoint
  address policy is only worth what the connection honours, and the
  library's send call takes no transport options), so the response is in
  hand and the sender emits it as `[:grappa, :push, :vendor_rejection]`
  — `%{status: integer, vendor: host, body: binary}` — on every non-2xx
  that is not the terminal 404 / 410. Until then this module had to
  attach to `ExNudge`'s own telemetry, the one route the library left
  for a body it never returned.

  Two consequences of that split, both deliberate:

    * **Terminal and transport failures stay silent here.** A 404 / 410
      sweep and a transport error already log at the sender with
      everything there is to say; a second line would add noise, not
      information. The sender simply does not emit for them.
    * **`retry-after` is reachable now and still not logged.** Response
      headers were unreachable while the library owned the request; they
      no longer are, but carrying one is its own change, not part of the
      transport move.

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
  @event [:grappa, :push, :vendor_rejection]

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
  def handle_telemetry(_, _, %{status: status, vendor: vendor, body: body}, _)
      when is_integer(status) and is_binary(vendor) and is_binary(body) do
    Logger.warning("push.vendor rejected", status: status, vendor: vendor, reason: reason(body))
  end

  # A body is vendor bytes of unbounded size and arbitrary encoding.
  @spec reason(binary()) :: String.t()
  defp reason(body), do: body |> cap() |> one_line()

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
