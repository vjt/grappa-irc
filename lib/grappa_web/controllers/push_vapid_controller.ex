defmodule GrappaWeb.PushVapidController do
  @moduledoc """
  Surfaces the server's VAPID public key to cic — push notifications
  cluster B2 (2026-05-14).

  ## Single endpoint

    * `GET /push/vapid-public-key` — returns
      `%{public_key: <base64url-encoded-uncompressed-P256-point>}`.
      Status 200 always (the key is loaded at boot via
      `config/runtime.exs`'s `fetch_env!` — Bootstrap refuses to start
      without it, so a running server always has a key to publish).
      503 path is not modeled; if the lib's app env is unset the
      controller raises and `FallbackController` returns the standard
      error envelope.

  ## Why unauthenticated

  cic SW calls `pushManager.subscribe({ userVisibleOnly: true,
  applicationServerKey: <bytes> })` before any user-session exists —
  the registration is per-browser-installation, not per-user; the
  POST that follows (`/push/subscriptions`) IS authenticated and
  binds the resulting subscription to the operator's user. Gating the
  public-key endpoint behind authn would force a chicken-and-egg
  reorder. The key is non-secret by design (the W3C Push spec
  publishes it as `applicationServerKey` in every subscription
  request).

  ## Source of truth

  Reads from `Application.get_env(:web_push_elixir, :vapid_public_key)`
  — the SAME key the upstream library signs payloads with. Routing
  through the library's namespace prevents drift between "what cic
  encrypts subscriptions to" and "what `Push.Sender` signs deliveries
  with" (the alternative — a sibling `:grappa, :vapid_public_key`
  mirror — would have to be kept in sync at boot).

  ## Caching at the cic side

  cic stores the value in `localStorage["cic.vapidPublicKey"]` on
  first fetch and refreshes only on an
  `InvalidApplicationServerKey` exception from the SW (which would
  indicate an operator-side rotation). No HTTP cache headers are set
  here — operator-controlled rotation cadence is rare and the
  payload is ~88 bytes; cic-side localStorage is the authoritative
  cache.
  """

  use GrappaWeb, :controller

  @doc """
  Returns the server's VAPID public key for cic SW subscription
  registration.
  """
  @spec show(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def show(conn, _) do
    public_key = Application.fetch_env!(:web_push_elixir, :vapid_public_key)
    json(conn, %{public_key: public_key})
  end
end
