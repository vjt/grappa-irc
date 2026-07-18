defmodule GrappaWeb.Admin.WSPresenceController do
  @moduledoc """
  Admin read surface over live WS presence + per-pid visibility freshness
  (#318). Behind `:admin_authn` — visitor + non-admin user collapse to
  403 upstream of the action.

  ## GET /admin/ws_presence

  A JSON-encodable snapshot (single-sourced by `Grappa.WSPresence.snapshot/0`):

      %{stale_ms: <ms>,
        users: [%{user_name, any_visible,
                  sockets: [%{pid, visibility, age_ms, fresh}, ...]}, ...]}

  This is the diagnostic for the iOS stale-`:visible` push bug: a reporter
  backgrounds the PWA and the operator reads back whether the socket goes
  stale/hidden (staleness downgrade working) or is still (wrongly)
  fresh-visible — the on-device efficacy signal the fix cannot confirm
  off-device. Read-only; no live state is mutated.
  """
  use GrappaWeb, :controller

  alias Grappa.WSPresence

  @doc false
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def index(conn, _) do
    json(conn, WSPresence.snapshot())
  end
end
