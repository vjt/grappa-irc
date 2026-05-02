defmodule GrappaWeb.FallbackController do
  @moduledoc """
  `action_fallback` target. Maps the **known** `{:error, _}` shapes
  returned by context functions to JSON HTTP responses so each action
  can stay on the happy path. Unknown error shapes intentionally raise
  `FunctionClauseError` and surface as a Phoenix 500 — adding a
  catch-all would hide context bugs that should be loud at boundary.

  ## Wire-string convention (A7)

  All atom-error responses use a single `%{error: "<token>"}` envelope
  whose value is the **snake_case stringification of the atom tag**:
  `:bad_request → "bad_request"`, `:not_found → "not_found"`, etc. The
  `Plugs.Authn` 401 body (`{"error":"unauthorized"}`) follows the same
  shape — clients parse the same envelope at every door. Adding a new
  tagged error means: pick a snake_case atom, add a clause here, and
  the wire string falls out automatically. Don't introduce a different
  envelope (`%{message: ...}`, `%{code: ...}`) for any sub-class —
  consistency at the wire is more valuable than per-error nuance.
  Validation errors (`%Ecto.Changeset{}`) use the **plural**
  `%{errors: ...}` envelope — deliberately distinct so clients can
  tell "field-level validation failed" from "single tagged error."

  Add a new clause whenever a context introduces a new tagged error
  (e.g. `{:error, :network_unknown}` in Task 5+) and update the spec
  in lockstep.
  """
  use GrappaWeb, :controller

  @spec call(
          Plug.Conn.t(),
          {:error,
           :bad_request
           | :forbidden
           | :not_found
           | :no_session
           | :invalid_credentials
           | :invalid_line
           | :unauthorized
           | Ecto.Changeset.t()}
        ) :: Plug.Conn.t()
  def call(conn, {:error, :bad_request}) do
    conn
    |> put_status(:bad_request)
    |> json(%{error: "bad_request"})
  end

  # `Plugs.Authn` runs upstream of every controller's `action_fallback`
  # so it can't lean on the implicit dispatch — but the 401 wire body
  # must match what this module produces, otherwise the snake_case
  # envelope splits across two emitters. M5: `Authn.unauthorized/1`
  # delegates here so the body bytes live in one place.
  def call(conn, {:error, :unauthorized}) do
    conn
    |> put_status(:unauthorized)
    |> json(%{error: "unauthorized"})
  end

  # CRLF / NUL byte in an IRC-bound field. Distinct from :bad_request
  # so client-side error handling can tell "you sent a malformed
  # request" apart from "your input would have smuggled an extra IRC
  # command onto the upstream wire."
  def call(conn, {:error, :invalid_line}) do
    conn
    |> put_status(:bad_request)
    |> json(%{error: "invalid_line"})
  end

  def call(conn, {:error, :not_found}) do
    conn
    |> put_status(:not_found)
    |> json(%{error: "not_found"})
  end

  # Subject is authenticated but the action is not available to its kind
  # (Task 30: visitor `POST /networks/:slug/nick`). Distinct from
  # `:unauthorized` (no/invalid bearer) — the bearer is fine, the verb
  # isn't allowed for this subject. Wire body distinguishes so the SPA
  # can render "this account can't do that" vs "log in again."
  def call(conn, {:error, :forbidden}) do
    conn
    |> put_status(:forbidden)
    |> json(%{error: "forbidden"})
  end

  # S14 oracle close: `:no_session` collapses to the same wire body as
  # `:not_found`. The internal tag is preserved so callers (Session
  # boundary, controllers) keep their typed return shape and operator
  # logs distinguish the two states; the wire bytes are uniform so a
  # probing user cannot tell "credential exists, session not running"
  # apart from "no credential" or "wrong slug." All three are
  # network-not-found from the wire's perspective.
  def call(conn, {:error, :no_session}) do
    conn
    |> put_status(:not_found)
    |> json(%{error: "not_found"})
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
