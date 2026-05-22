defmodule GrappaWeb.PushVapidController do
  @moduledoc """
  Surfaces the server's VAPID public key to cic — push notifications
  cluster B2 (2026-05-14).

  ## Single endpoint

    * `GET /push/vapid-public-key` — returns
      `%{public_key: <base64url-encoded-uncompressed-P256-point>}`.
      Status 200 always (the key is pinned in `:persistent_term` at
      application boot via `Grappa.Push.boot/0`, which raises if the
      `:web_push_elixir` env keys are missing — Bootstrap refuses to
      start without them, so a running server always has a key to
      publish).

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

  Reads from `Grappa.Push.vapid_public_key/0`, which returns the
  value pinned in `:persistent_term` at application boot via
  `Grappa.Push.boot/0` (H16, REV-D 2026-05-22 — pre-fix this
  controller did `Application.fetch_env!(:web_push_elixir,
  :vapid_public_key)` per request, the lone CLAUDE.md "boot-time
  only, runtime banned" violation in the codebase). The upstream
  library's own signing path still reads from `Application.get_env/2`
  at delivery time; that's outside our control. We mirror the value
  at boot so OUR callers observe a pinned constant.

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

  alias Grappa.Push

  @doc """
  Returns the server's VAPID public key for cic SW subscription
  registration.
  """
  @spec show(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def show(conn, _) do
    json(conn, %{public_key: Push.vapid_public_key()})
  end
end
