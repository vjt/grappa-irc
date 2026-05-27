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
  `GET /admin/visitors` (and `GET /admin/credentials`), not here.

  Returns `200 OK` with `%{"sessions" => [...]}`. Wire shape pinned
  by `Grappa.LiveIntrospection.AdminWire`.

  ## POST /admin/sessions/:id/disconnect (M-cluster M-9a)

  T32 park for user sessions: stops the pid + transitions the
  credential's `connection_state` to `:parked`. For visitor
  sessions: collapses to terminate semantics (visitors have no
  `connection_state` to park; the uniform surface choice — see
  `Grappa.Operator.disconnect_session/3` docs — keeps cic from
  growing a subject-discriminated parallel state machine).

  Returns `204 No Content` on success (including the idempotent
  "credential already :parked / :failed" case — the Operator
  boundary absorbs `:not_connected` so the wire stays uniform).

  Returns `400` on malformed `:id` (see `parse_session_id/1`),
  `404` when no credential row exists for the parsed key, `422
  cannot_disconnect_self` if the admin targets their own user
  session (server-side foot-gun gate).

  ## DELETE /admin/sessions/:id (M-cluster M-9a)

  Synchronously stops the `Session.Server` pid without touching the
  DB row. Distinct from `DELETE /admin/visitors/:id` which also
  deletes the visitor row. Useful for force-quitting a stuck pid
  while preserving the credential / visitor row's intent.

  Idempotent: returns `204` whether or not a pid was registered.
  Same `422` self-protection as POST disconnect.

  ## URL `:id` shape

  Composite string `"<subject_kind>:<subject_id>:<network_id>"` —
  parseable, stable across BEAM restarts. Pid in URL is rejected
  per the `Grappa.LiveIntrospection.AdminWire` pid_inspect contract
  (cic must NEVER round-trip a pid).
  """
  use GrappaWeb, :controller

  alias Grappa.{Accounts, LiveIntrospection, Operator, Session, Visitors}
  alias Grappa.LiveIntrospection.AdminWire
  alias GrappaWeb.Admin.AuthPlug

  @doc """
  Enumerate every live `Session.Server` registered in the registry.
  Registry-driven (one row = one live pid); the U-0 honesty signal
  for `:connected`-but-no-pid lives on `/admin/visitors` and
  `/admin/credentials`, not here.

  Pre-joins `subject_label` per row via two batched DB lookups
  (`Accounts.get_users_by_ids/1` + `Visitors.get_by_ids/1`) — one
  query per subject_kind regardless of session count. The composition
  lives here, not in `LiveIntrospection`, because that boundary
  excludes `Accounts` / `Visitors` deps (pure live-state module).
  `subject_label: nil` IS the gemello honesty signal: BEAM has a
  pid but the DB row is gone (orphan pid — operator can spot from
  the table without paging through the registry directly).
  """
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def index(conn, _) do
    entries = LiveIntrospection.list_sessions()
    {user_ids, visitor_ids} = partition_subject_ids(entries)
    users = Accounts.get_users_by_ids(user_ids)
    visitors = Visitors.get_by_ids(visitor_ids)
    # MAX(accounts_sessions.last_seen_at) per subject. Two batched
    # queries (one per subject_kind, same shape as the labels lookup)
    # so the controller's DB cost stays O(1) regardless of session
    # count. Missing keys → `nil` on the wire, same U-0 honesty rule
    # the label resolution uses.
    user_last_seen = Accounts.max_last_seen_by_subject_ids(:user, user_ids)
    visitor_last_seen = Accounts.max_last_seen_by_subject_ids(:visitor, visitor_ids)

    rows =
      Enum.map(entries, fn entry ->
        AdminWire.session_to_admin_json(
          entry,
          resolve_label(entry, users, visitors),
          resolve_last_seen(entry, user_last_seen, visitor_last_seen)
        )
      end)

    json(conn, %{sessions: rows})
  end

  # Split the registry-scan into `(user_ids, visitor_ids)` so each
  # context's batched lookup gets the relevant ids only. No `Enum.uniq`
  # needed: the registry key shape `{:session, subject, network_id}` is
  # unique per `(subject, network_id)` pair, so a single `user_id` can
  # appear N times (one per joined network) — passing the dups to the
  # `id IN ^ids` query is harmless (the DB returns one row per id) and
  # the dedup-via-Map.new at the resolve site collapses them.
  defp partition_subject_ids(entries) do
    Enum.reduce(entries, {[], []}, fn entry, {users, visitors} ->
      case entry.subject do
        {:user, id} -> {[id | users], visitors}
        {:visitor, id} -> {users, [id | visitors]}
      end
    end)
  end

  defp resolve_label(%{subject: {:user, id}}, users, _) do
    case Map.get(users, id) do
      %Accounts.User{name: name} -> name
      nil -> nil
    end
  end

  defp resolve_label(%{subject: {:visitor, id}}, _, visitors) do
    case Map.get(visitors, id) do
      %Visitors.Visitor{nick: nick} -> nick
      nil -> nil
    end
  end

  defp resolve_last_seen(%{subject: {:user, id}}, user_last_seen, _),
    do: Map.get(user_last_seen, id)

  defp resolve_last_seen(%{subject: {:visitor, id}}, _, visitor_last_seen),
    do: Map.get(visitor_last_seen, id)

  @doc """
  T32 disconnect verb — parks the credential + stops the pid (user
  subject) OR collapses to terminate (visitor subject).
  """
  @spec disconnect(Plug.Conn.t(), map()) ::
          Plug.Conn.t()
          | {:error, :bad_request | :not_found | :cannot_disconnect_self}
  def disconnect(conn, %{"id" => id}) do
    with {:ok, {subject, network_id}} <- parse_session_id(id),
         :ok <-
           Operator.disconnect_session(
             subject,
             network_id,
             actor_user_id(conn),
             AuthPlug.actor_from_conn(conn)
           ) do
      send_resp(conn, :no_content, "")
    end
  end

  @doc """
  Force-stop the pid without touching the DB row. Idempotent.
  """
  @spec delete(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :bad_request | :cannot_disconnect_self}
  def delete(conn, %{"id" => id}) do
    with {:ok, {subject, network_id}} <- parse_session_id(id),
         :ok <-
           Operator.terminate_session(
             subject,
             network_id,
             actor_user_id(conn),
             AuthPlug.actor_from_conn(conn)
           ) do
      send_resp(conn, :no_content, "")
    end
  end

  # `:admin_authn` upstream guarantees `current_subject = {:user, _}`,
  # so the bare match is safe — visitor subjects never reach this
  # controller (`AuthPlug.call/2` collapses them to 403). The
  # FunctionClauseError on shape drift IS the intended fail-loud
  # signal: silently returning `nil` would let a future
  # `:admin_authn` regression pass `nil` as `actor_user_id` and
  # disable the self-disconnect protection without anyone noticing.
  @spec actor_user_id(Plug.Conn.t()) :: String.t()
  defp actor_user_id(conn) do
    case conn.assigns.current_subject do
      {:user, %{id: id}} -> id
    end
  end

  # Composite `"<subject_kind>:<subject_id>:<network_id>"` parse.
  # Exactly two `:` delimiters; subject_kind ∈ {user, visitor};
  # subject_id is a valid UUID; network_id is a positive integer.
  # Any deviation → `{:error, :bad_request}` so the FallbackController
  # surfaces 400 (distinct from 404 "parse OK but no live row").
  @spec parse_session_id(String.t()) ::
          {:ok, {Session.subject(), pos_integer()}} | {:error, :bad_request}
  defp parse_session_id(id) when is_binary(id) do
    with [kind_str, uuid_str, network_str] <- String.split(id, ":", parts: 3),
         {:ok, kind} <- parse_subject_kind(kind_str),
         {:ok, uuid} <- Ecto.UUID.cast(uuid_str),
         {network_id, ""} <- Integer.parse(network_str),
         true <- network_id > 0 do
      {:ok, {{kind, uuid}, network_id}}
    else
      _ -> {:error, :bad_request}
    end
  end

  defp parse_subject_kind("user"), do: {:ok, :user}
  defp parse_subject_kind("visitor"), do: {:ok, :visitor}
  defp parse_subject_kind(_), do: :error
end
