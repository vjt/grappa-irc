defmodule GrappaWeb.Admin.AuthPlug do
  @moduledoc """
  Admin gate plug — runs after `GrappaWeb.Plugs.Authn` in the
  `:admin_authn` pipeline. Lets the request through ONLY if
  `conn.assigns.current_subject` is `{:user, %User{is_admin: true}}`;
  every other shape (visitor subject, non-admin user subject) collapses
  to the uniform 403 wire body via `FallbackController`.

  ## Why a separate plug instead of an `action_fallback` clause

  Admin gating is a pipeline-shape decision, not an action-shape
  decision. Every controller mounted under `scope "/admin"` inherits
  the gate identically — adding a new admin endpoint is a route entry,
  not a per-controller boilerplate that future authors might forget.
  Visitor subjects ALWAYS fail (visitors can't be admins by construction
  — `is_admin` lives on `User` only); non-admin users fail today; admin
  users pass.

  The plug halts the conn before the controller sees it, so existing
  controller logic is untouched. M-cluster M-2 (admin pipeline +
  GET /admin/me) lands the first endpoint behind this gate; every
  subsequent `/admin/*` route inherits the same plug stack.

  ## Wire body — uniform with FallbackController's `:forbidden`

  Delegates to `GrappaWeb.FallbackController.call({:error, :forbidden})`
  so the JSON body bytes (`{"error":"forbidden"}`) live in ONE module.
  Mirrors how `GrappaWeb.Plugs.Authn` produces the 401 body — single
  source of truth for snake_case error envelopes per FallbackController
  moduledoc A7.
  """
  @behaviour Plug

  import Plug.Conn

  alias Grappa.Accounts.User
  alias GrappaWeb.FallbackController

  @impl Plug
  def init(opts), do: opts

  @impl Plug
  def call(%{assigns: %{current_subject: {:user, %User{is_admin: true}}}} = conn, _) do
    conn
  end

  def call(conn, _) do
    conn
    |> FallbackController.call({:error, :forbidden})
    |> halt()
  end

  @doc """
  Extract `{user_id, user_name}` from an admin-gated `conn`. Single
  source of truth for the M-11 admin-event actor attribution helper
  that every controller under `scope "/admin"` previously redefined.

  Mandatory invariant: `:admin_authn` upstream guarantees
  `current_subject == {:user, %User{is_admin: true}}`, so the bare
  match is the intentional fail-loud signal if a future pipeline
  regression drops the shape.
  """
  @spec actor_from_conn(Plug.Conn.t()) :: {String.t(), String.t()}
  def actor_from_conn(conn) do
    {:user, %User{id: id, name: name}} = conn.assigns.current_subject
    {id, name}
  end
end
