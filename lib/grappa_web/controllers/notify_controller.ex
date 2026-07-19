defmodule GrappaWeb.NotifyController do
  @moduledoc """
  REST surface for the `/notify` presence watch list (GH #247) —
  `/networks/:network_id/notify`.

  Thin per CLAUDE.md: parse params, call `Grappa.Notify` (the DB-owned
  list) + `Grappa.Session.notify_changed/4` (live MONITOR/WATCH sync),
  render. The same context functions back the cic `/notify` command and
  the Watched panel — one authoritative list, two faces.

  ## Listing combines both sources of truth

  `GET` returns the DB list AND the live presence map. They are
  separate sources of truth (CLAUDE.md): the list survives reconnects
  in sqlite; presence lives on the session process. `presence: null`
  is the honesty signal that no session is running (parked / failed /
  backoff) — never fabricated from the DB side.

  ## Live sync contract

  Mutations diff-sync the running session (`notify_changed/4`): adds
  send `MONITOR + / WATCH +`, removes send `MONITOR - / WATCH -`, and
  the session's presence map tracks in lockstep. With no live session
  the sync is a no-op — the next (re)connect's end-of-MOTD arm reads
  the mutated DB list.

  Iso boundary: `Plugs.ResolveNetwork` collapses unknown-slug /
  not-your-network to 404 before any action runs, same as the sibling
  `/networks/:network_id` resources.
  """
  use GrappaWeb, :controller

  alias Grappa.Accounts.User
  alias Grappa.IRC.Identifier
  alias Grappa.{Notify, Session}
  alias Grappa.Notify.Wire
  alias Grappa.Visitors.Visitor
  alias GrappaWeb.Subject, as: WebSubject

  @doc """
  `GET /networks/:network_id/notify` — the watch list for the current
  subject on this network plus the live presence map (`null` when no
  session is running).
  """
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def index(conn, _) do
    subject = session_subject(conn)
    network = conn.assigns.network

    entries = Notify.list(subject, network.id)

    presence =
      case Session.presence_snapshot(subject, network.id) do
        {:ok, map} -> map
        {:error, _} -> nil
      end

    json(conn, %{entries: Enum.map(entries, &Wire.render/1), presence: presence})
  end

  @doc """
  `POST /networks/:network_id/notify` — body `{"nicks": ["a", "b"]}`.
  Atomic batch add; any invalid nick rejects the whole batch (422 via
  FallbackController changeset rendering), and a batch that would push
  the list past `Grappa.Notify.max_entries/0` is 422 `list_full` (the
  over-cap batch SHAPE is rejected here before building changesets;
  the post-state cap itself is enforced inside `Notify.add/4`'s
  transaction). 201 + the added entries.
  """
  @spec create(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :bad_request | :list_full | Ecto.Changeset.t()}
  def create(conn, %{"nicks" => nicks}) when is_list(nicks) and nicks != [] do
    subject = session_subject(conn)
    network = conn.assigns.network

    with :ok <- validate_batch_size(nicks),
         :ok <- validate_nicks(nicks),
         # Snapshot the pre-add fold set so the live sync only arms
         # genuinely-new nicks — an idempotent re-add must not re-emit
         # `MONITOR +`/`WATCH +` for already-armed targets (review nit
         # 2026-07-19). Same read the batch-size cap does; cheap.
         pre_folds =
           MapSet.new(Notify.list(subject, network.id), &Identifier.canonical_nick(&1.nick)),
         {:ok, entries} <- Notify.add(subject, network.id, nicks, subject_label(conn)) do
      added =
        Enum.reject(nicks, &MapSet.member?(pre_folds, Identifier.canonical_nick(&1)))

      :ok = Session.notify_changed(subject, network.id, added, [])

      conn
      |> put_status(:created)
      |> json(%{entries: Enum.map(entries, &Wire.render/1)})
    end
  end

  def create(_, _), do: {:error, :bad_request}

  @doc """
  `DELETE /networks/:network_id/notify/:nick` — remove one nick
  (fold-matched, idempotent). 200 `{ok: true}` either way.
  """
  @spec remove(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def remove(conn, %{"nick" => nick}) when is_binary(nick) and nick != "" do
    subject = session_subject(conn)
    network = conn.assigns.network

    :ok = Notify.remove(subject, network.id, [nick], subject_label(conn))
    :ok = Session.notify_changed(subject, network.id, [], [nick])
    json(conn, %{ok: true})
  end

  @doc """
  `DELETE /networks/:network_id/notify` — wipe the list for this
  network (`/notify clear`). 200 `{ok: true}`.
  """
  @spec clear(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def clear(conn, _) do
    subject = session_subject(conn)
    network = conn.assigns.network

    # Snapshot the nicks BEFORE the wipe — the live session needs the
    # removal set to send `MONITOR -`/`WATCH -` for each armed target.
    removed = Enum.map(Notify.list(subject, network.id), & &1.nick)

    :ok = Notify.clear(subject, network.id, subject_label(conn))
    :ok = Session.notify_changed(subject, network.id, [], removed)
    json(conn, %{ok: true})
  end

  # A batch longer than the cap can never succeed — reject the shape
  # before building N changesets. The cap itself (post-state row count,
  # fold-dedup-aware) is enforced inside Notify.add/4's transaction.
  @spec validate_batch_size([term()]) :: :ok | {:error, :list_full}
  defp validate_batch_size(nicks) do
    if length(nicks) <= Notify.max_entries() do
      :ok
    else
      {:error, :list_full}
    end
  end

  # Every nick must be a non-empty string; content validation
  # (Identifier.valid_nick?/1) lives in the Entry changeset so REST and
  # any future door share one rule — this is just the shape check.
  @spec validate_nicks([term()]) :: :ok | {:error, :bad_request}
  defp validate_nicks(nicks) do
    if Enum.all?(nicks, &(is_binary(&1) and &1 != "")) do
      :ok
    else
      {:error, :bad_request}
    end
  end

  @spec session_subject(Plug.Conn.t()) :: Grappa.Session.subject()
  defp session_subject(conn), do: WebSubject.to_session(conn.assigns.current_subject)

  # Same subject-label derivation as `ArchiveController` /
  # `ReadCursorController`: user → `user.name`, visitor →
  # `"visitor:" <> id` (the shape `UserSocket` assigns to `:user_name`,
  # so the notify_list broadcast reaches the subject's own topic).
  @spec subject_label(Plug.Conn.t()) :: String.t()
  defp subject_label(conn) do
    case conn.assigns.current_subject do
      {:user, %User{name: name}} -> name
      {:visitor, %Visitor{id: id}} -> "visitor:" <> id
    end
  end
end
