defmodule Grappa.AccountDeletion do
  @moduledoc """
  #157 — self-service account deletion: an explicit, deliberate,
  IRREVERSIBLE total wipe of the CALLER'S OWN account + all associated
  state. The single self-service door (`DELETE /me`) routes here.

  ## Distinct from quit (#126)

  `quit` PRESERVES a persistent identity — a registered visitor's row +
  scrollback survive (`Visitors.purge_if_anon/1` no-ops it), and a user's
  account survives a park-all. `delete_account/1` is the ONLY self-service
  path that DESTROYS a persistent identity's data. The two are surfaced as
  separately-confirmed affordances in cic; the server NEVER wipes on quit.

  ## Subject routing + gating

    * `{:user, %User{is_admin: true}}` → `{:error, :forbidden}`. Admins
      cannot self-delete (issue #157) — an operator who needs to remove an
      admin uses the admin surface (`DELETE /admin/users/:id`), which keeps
      the last-admin lockout guard.
    * `{:user, %User{is_admin: false}}` → stop ALL the user's live
      `Session.Server`s (one per bound network), THEN `Accounts.delete_user/1`.
    * `{:visitor, %Visitor{password_encrypted: nil}}` → `{:error, :forbidden}`.
      An anon visitor has no persistent identity to delete — its only
      teardown verb is `quit` (`DELETE /auth/logout`'s anon branch already
      stops + purges). Mirrors `SessionController.require_registered_visitor/1`:
      server-side defense-in-depth, not a reliance on the cic gate.
    * `{:visitor, %Visitor{}}` (registered) → stop the live session, THEN
      `Visitors.delete/1`.

  ## Teardown → wipe ordering

  The live `Session.Server` is stopped BEFORE the `Repo.delete` (mirrors
  `Operator.delete_visitor/2`): an in-flight scrollback persist can't trip a
  `*_id` FK once the GenServer has drained via `terminate/2`, and the
  capacity slot frees synchronously. The DB-level `ON DELETE CASCADE` on
  every subject-keyed FK (sessions, messages, query_windows, read_cursors,
  network_credentials, user_settings, push_subscriptions, …) wipes the
  dependents in the same transaction as the parent-row delete.

  No admin-event is emitted — this is the SELF-SERVICE door (no admin
  actor). The admin-attributed wipe (`Operator.delete_visitor/2`) is a
  separate door that records `:visitor_deleted`; both compose the same
  `Session.stop_session` + `*.delete` primitives ("reuse the verbs").

  Socket teardown + auth-session revocation are the CONTROLLER's job
  (`MeController.delete/2`): this context stays free of web-layer deps.
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.Accounts, Grappa.Networks, Grappa.Session, Grappa.Visitors]

  alias Grappa.{Accounts, Networks, Session, Visitors}
  alias Grappa.Accounts.User
  alias Grappa.Networks.Credentials
  alias Grappa.Visitors.Visitor

  require Logger

  # Upstream QUIT line for the teardown-before-wipe stop. Static literal
  # (no CR/LF/NUL) so `Session.stop_session/3`'s pre-QUIT never returns
  # `:invalid_line` — same contract as `Operator`'s `@terminate_reason`.
  @quit_reason "account deleted"

  @typedoc """
  Self-delete subject — the web-layer `current_subject` tuple carrying the
  loaded struct (`GrappaWeb.Subject.t()`), which is also what the
  controller hands in verbatim. A user can only ever target ITSELF: the
  caller's own assigns ARE the subject, there is no `:id` param to spoof.
  """
  @type subject :: {:user, User.t()} | {:visitor, Visitor.t()}

  @doc """
  Tear down + wipe the caller's own account. Returns `:ok` on a completed
  wipe, `{:error, :forbidden}` for an admin user or anon visitor (neither
  is offered self-delete), `{:error, :not_found}` if the row vanished
  concurrently (e.g. a racing admin delete).

  The forbidden cases are pattern-matched FIRST so the wipe clauses carry
  no negated guards (a bare `%User{is_admin: false}` / `%Visitor{}` after
  the nil/true clauses is necessarily the offered case).
  """
  @spec delete_account(subject()) :: :ok | {:error, :forbidden | :not_found}
  def delete_account({:user, %User{is_admin: true}}), do: {:error, :forbidden}

  def delete_account({:user, %User{is_admin: false} = user}) do
    :ok = stop_all_user_sessions(user)

    case Accounts.delete_user(user) do
      :ok ->
        :ok

      {:error, :not_found} ->
        {:error, :not_found}
        # `:last_admin` is unreachable: a non-admin user can never be the
        # last admin (`Accounts.delete_user/1` only returns it when the
        # row's `is_admin` is true). If it ever fires, the invariant is
        # broken — crash loudly rather than swallow (CLAUDE.md let-it-crash).
    end
  end

  def delete_account({:visitor, %Visitor{password_encrypted: nil}}), do: {:error, :forbidden}

  def delete_account({:visitor, %Visitor{} = visitor}) do
    :ok = stop_visitor_session(visitor)
    Visitors.delete(visitor.id)
  end

  # Stop every live Session.Server the user owns (one per bound network)
  # BEFORE the cascade delete drops the credential rows. Idempotent per
  # network: `stop_session/3` returns `:ok` whether or not a pid is
  # registered, so `:parked` / `:failed` credentials (no live pid) are
  # harmless no-ops.
  @spec stop_all_user_sessions(User.t()) :: :ok
  defp stop_all_user_sessions(%User{id: user_id} = user) do
    for credential <- Credentials.list_credentials_for_user(user) do
      :ok = Session.stop_session({:user, user_id}, credential.network_id, @quit_reason)
    end

    :ok
  end

  # Resolve the visitor's single network → stop its session. An orphaned
  # visitor (network row deleted out from under it) has no live session to
  # stop; `Visitors.delete/1` still cascades the row's dependents.
  @spec stop_visitor_session(Visitor.t()) :: :ok
  defp stop_visitor_session(%Visitor{id: id, network_slug: slug}) do
    case Networks.get_network_by_slug(slug) do
      {:ok, %Networks.Network{id: network_id}} ->
        Session.stop_session({:visitor, id}, network_id, @quit_reason)

      {:error, :not_found} ->
        Logger.warning("account-delete: visitor network not found, no session to stop",
          visitor_id: id,
          network: slug
        )

        :ok
    end
  end
end
