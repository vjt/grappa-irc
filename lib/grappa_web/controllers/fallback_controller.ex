defmodule GrappaWeb.FallbackController do
  @moduledoc """
  `action_fallback` target. Maps the **known** `{:error, _}` shapes
  returned by context functions to JSON HTTP responses so each action
  can stay on the happy path. Unknown error shapes intentionally raise
  `FunctionClauseError` and surface as a Phoenix 500 — adding a
  catch-all would hide context bugs that should be loud at boundary.

  Add a new clause whenever a context introduces a new tagged error
  (e.g. `{:error, :network_unknown}` in Task 5+) and update the spec
  in lockstep.
  """
  use GrappaWeb, :controller

  @spec call(
          Plug.Conn.t(),
          {:error, :bad_request | :not_found | :no_session | :invalid_credentials | Ecto.Changeset.t()}
        ) :: Plug.Conn.t()
  def call(conn, {:error, :bad_request}) do
    conn
    |> put_status(:bad_request)
    |> json(%{error: "bad request"})
  end

  def call(conn, {:error, :not_found}) do
    conn
    |> put_status(:not_found)
    |> json(%{error: "not found"})
  end

  def call(conn, {:error, :no_session}) do
    conn
    |> put_status(:not_found)
    |> json(%{error: "no session"})
  end

  # Login failure — uniform shape regardless of which credential
  # half was wrong (mirrors `Accounts.get_user_by_credentials/2`'s
  # oracle posture). The 401 wire body matches `Plugs.Authn`'s
  # `{"error":"unauthorized"}` shape closely so client UX collapses
  # both authn failure paths to the same "drop credentials, send to
  # login" branch.
  def call(conn, {:error, :invalid_credentials}) do
    conn
    |> put_status(:unauthorized)
    |> json(%{error: "invalid_credentials"})
  end

  def call(conn, {:error, %Ecto.Changeset{} = changeset}) do
    conn
    |> put_status(:unprocessable_entity)
    |> json(%{errors: format_changeset_errors(changeset)})
  end

  defp format_changeset_errors(changeset) do
    Ecto.Changeset.traverse_errors(changeset, fn {msg, opts} ->
      Enum.reduce(opts, msg, fn {k, v}, acc ->
        String.replace(acc, "%{#{k}}", to_string(v))
      end)
    end)
  end
end
