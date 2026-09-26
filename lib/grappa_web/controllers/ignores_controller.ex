defmodule GrappaWeb.IgnoresController do
  @moduledoc """
  REST surface for the `/ignore` list (GH #162, issue 2294) —
  `/networks/:network_id/ignores`.

  Thin per CLAUDE.md: parse params, call `Grappa.UserSettings` (the DB-owned
  list) + `Grappa.Session.ignores_changed/3` (live sync), render through
  `GrappaWeb.IgnoresJSON`. The same context functions back the cic `/ignore`
  + `/unignore` commands — one authoritative list, two faces.

  ## An entry is a PAIR (issue 2294)

  An entry is a `nick!user@host` mask and an OPTIONAL glob over the message
  text; a line is dropped when BOTH match. `text_pattern` is absent or
  `null` for the #162 entry, and the two doors treat it identically:

    * `POST` takes it in the body next to `mask`.
    * `DELETE` takes it as a QUERY parameter, because the mask already owns
      the path segment and a text pattern carries spaces and slashes. Absent
      means the PATTERN-LESS entry — a removal is the exact inverse of the
      add that wrote it, never a wildcard over every entry sharing the mask.

  ## The list is the reply, every time

  `POST` and `DELETE` both answer with the resulting list rather than the one
  entry touched. A client that renders the list has nothing to reconcile, and
  an idempotent re-add (already present → 200, same list) is indistinguishable
  from a first add on the wire, which is the point of idempotence.

  ## Live sync contract

  Every mutation pushes the WHOLE resulting list to the live session
  (`Session.ignores_changed/3`), which replaces `state.ignores`. No session
  running is a normal `:ok` — the next spawn reads the list at init.

  Iso boundary: `Plugs.ResolveNetwork` collapses unknown-slug /
  not-your-network to 404 before any action runs, same as `/notify`.
  """
  use GrappaWeb, :controller

  alias Grappa.{Session, UserSettings}
  alias GrappaWeb.Subject, as: WebSubject

  @doc "`GET /networks/:network_id/ignores` — the entries for this subject on this network."
  @spec index(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def index(conn, _) do
    network = conn.assigns.network
    render(conn, :index, entries: UserSettings.get_ignores(session_subject(conn), network.slug))
  end

  @doc """
  `POST /networks/:network_id/ignores` — add one entry. Body
  `{"mask": "...", "text_pattern": "..."}`; a bare nick normalises to
  `nick!*@*` and `text_pattern` may be omitted or `null`. 201 with
  `{masks, entries, mask, text_pattern, outcome}`; 422 `invalid_mask` /
  `invalid_text_pattern` / `list_full` via FallbackController.
  """
  @spec create(Plug.Conn.t(), map()) ::
          Plug.Conn.t()
          | {:error, :bad_request | :invalid_mask | :invalid_text_pattern | :list_full | term()}
  def create(conn, %{"mask" => mask} = params) when is_binary(mask) and mask != "" do
    with {:ok, text} <- text_pattern(params) do
      mutate(conn, &UserSettings.add_ignore(&1, &2, mask, text, &3), :created)
    end
  end

  def create(_, _), do: {:error, :bad_request}

  @doc """
  `DELETE /networks/:network_id/ignores/:mask[?text_pattern=...]` — remove one
  entry (normalised before comparing, idempotent). 200 with the resulting
  list either way.
  """
  @spec remove(Plug.Conn.t(), map()) ::
          Plug.Conn.t() | {:error, :bad_request | :invalid_mask | :invalid_text_pattern | term()}
  def remove(conn, %{"mask" => mask} = params) when is_binary(mask) and mask != "" do
    with {:ok, text} <- text_pattern(params) do
      mutate(conn, &UserSettings.remove_ignore(&1, &2, mask, text, &3), :ok)
    end
  end

  # Both mutations differ only in the context verb and the success status:
  # resolve the subject + this network's casemapping, run the verb, sync the
  # live session with the WHOLE resulting list, render. Implement-once —
  # a second copy is how the two doors would drift on the sync.
  @spec mutate(
          Plug.Conn.t(),
          (Session.subject(), String.t(), Grappa.IRC.Identifier.casemapping() ->
             {:ok, UserSettings.ignore_outcome(), Grappa.IRC.Ignore.t(), [Grappa.IRC.Ignore.t()]}
             | {:error, term()}),
          :created | :ok
        ) :: Plug.Conn.t() | {:error, term()}
  defp mutate(conn, verb, status) do
    subject = session_subject(conn)
    network = conn.assigns.network

    # #537 ingress: the mask folds with THIS network's casemapping, read off
    # the live session (`:ascii` when none — the same door `/notify` uses).
    casemapping = Session.casemapping(subject, network.id)

    with {:ok, outcome, entry, entries} <- verb.(subject, network.slug, casemapping) do
      :ok = Session.ignores_changed(subject, network.id, entries)

      conn
      |> put_status(status)
      |> render(:mutation, entries: entries, entry: entry, outcome: outcome)
    end
  end

  # The one place the optional half is read off the wire. Absent and JSON
  # `null` both mean "no pattern" — the #162 entry. Anything that is not a
  # string is a malformed request rather than an empty pattern, and says so
  # at the boundary instead of reaching the normaliser as a surprise.
  @spec text_pattern(map()) :: {:ok, String.t() | nil} | {:error, :bad_request}
  defp text_pattern(params) do
    case Map.get(params, "text_pattern") do
      nil -> {:ok, nil}
      text when is_binary(text) -> {:ok, text}
      _ -> {:error, :bad_request}
    end
  end

  defp session_subject(conn), do: WebSubject.to_session(conn.assigns.current_subject)
end
