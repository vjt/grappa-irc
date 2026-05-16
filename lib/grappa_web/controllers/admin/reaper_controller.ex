defmodule GrappaWeb.Admin.ReaperController do
  @moduledoc """
  Admin verb to force-trigger the `Grappa.Visitors.Reaper` sweep on
  demand (M-cluster M-5). Behind the `:admin_authn` pipeline;
  visitor + non-admin user collapse to 403 upstream.

  The Reaper runs its scheduled tick every 60s; this endpoint is the
  operator-on-demand variant. Same code path as the
  `bin/grappa reap-visitors` verb — both call into
  `Grappa.Operator.reap_visitors/0` (the typed sibling of
  `reap_visitors!/0`, no stdout side-effect). One feature, one code
  path, every door.

  ## POST /admin/reaper/run

  Returns `202 Accepted` + `%{"swept_count" => N, "swept_at" => ISO8601}`.
  202 (not 200) because the verb is conceptually deferred operator
  intent — even though the underlying sweep runs synchronously inside
  the handler, the semantic is "we triggered the reaper" rather than
  "this is the canonical reaper state".

  ## Three-class parity matrix is N/A

  Per `feedback_e2e_user_class_parity_matrix`: operator-facing
  endpoints are admin-gated by `:admin_authn`; visitor + non-admin
  user behavior is exactly "403 forbidden, no action runs". Same
  shape as `GrappaWeb.Admin.VisitorsControllerTest`.
  """
  use GrappaWeb, :controller

  alias Grappa.Operator

  @doc """
  Force-trigger the Reaper. Returns the swept count + timestamp.
  """
  @spec run(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def run(conn, _) do
    {:ok, count} = Operator.reap_visitors()

    conn
    |> put_status(:accepted)
    |> json(%{swept_count: count, swept_at: DateTime.utc_now()})
  end
end
