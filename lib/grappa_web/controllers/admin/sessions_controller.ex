defmodule GrappaWeb.Admin.SessionsController do
  @moduledoc """
  Admin verbs over live `Grappa.Session.Server` processes. Behind
  the `:admin_authn` pipeline; visitor + non-admin user collapse to
  403 upstream.

  ## GET /admin/sessions (M-cluster M-4) — live inventory

  Enumerates every live `Session.Server` registered in
  `Grappa.SessionRegistry`. Registry-driven: every row in the
  response represents a live pid. Visitor / user rows whose DB
  intent says "active" but BEAM has no pid surface on
  `GET /admin/visitors` (and future M-6 `/admin/credentials`),
  not here.

  Returns `200 OK` with `%{"sessions" => [...]}`. Wire shape pinned
  by `Grappa.Session.AdminWire`.
  """
  use GrappaWeb, :controller

  alias Grappa.LiveIntrospection
  alias Grappa.LiveIntrospection.AdminWire

  @doc """
  Enumerate every live `Session.Server` registered in the registry.
  Registry-driven (one row = one live pid); the U-0 honesty signal
  for `:connected`-but-no-pid lives on `/admin/visitors` (and the
  future M-6 `/admin/credentials`), not here.
  """
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def index(conn, _) do
    rows = Enum.map(LiveIntrospection.list_sessions(), &AdminWire.session_to_admin_json/1)
    json(conn, %{sessions: rows})
  end
end
