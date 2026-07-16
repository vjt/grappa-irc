defmodule Grappa.SubjectSearch do
  @moduledoc """
  #257 — ONE unified search over BOTH subject kinds (users + visitors) for
  the admin vhost-grant autocomplete. Returns a tagged-union
  `Grappa.SubjectSearch.Result` list keyed on the closed set
  `:user | :visitor`.

  ## Why unified (vjt 2026-07-15)

  The vhost-grant form used to carry a `user | visitor` type-select plus a
  raw `subject_id` text input. #257 collapses that into ONE autocomplete
  box: the operator types a name/nick, sees type-tagged results, and picks
  one. The result's stable `{type, id}` maps 1:1 onto the grant body
  `{subject_type, subject_id}` — no re-plumbing of the grant path.

  ## Boundary-clean composition, not a subject-blind reader

  Each leg is owned by its own context and scoped to its own subject
  column: users via `Accounts.search_users/2` (the `users` table),
  visitors via `Credentials.search_visitor_credentials_by_nick/2` (the
  `visitor_id IS NOT NULL` credential path). The two legs are UNIONed
  here in Elixir — never a single polymorphic query with a nullable FK in
  a `NOT IN`, which is the #211-p7 NULL-poisoning class
  ([[feedback_not_in_null_poisoning_polymorphic_subquery]]). Mirror of
  `Grappa.Subject`'s role as the cross-subject hub; the controller stays a
  thin call + render.

  ## Ordering + limit

  Users first (ordered by name), then visitors (ordered by nick); the
  combined list is clamped to `limit`. A multi-network visitor holding the
  same nick on N networks contributes N rows — the "network - nickname"
  disambiguation the operator needs. On overflow, users rank ahead of
  visitors; the operator narrows by typing more (expected autocomplete UX,
  not a silent coverage cap).
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.Accounts, Grappa.Networks],
    exports: [AdminWire, Result]

  alias Grappa.Accounts
  alias Grappa.Networks.Credentials
  alias Grappa.SubjectSearch.Result

  @doc """
  Searches users + visitors for `query` (a case-insensitive substring;
  the visitor leg additionally rfc1459-folds the nick, GH #121), returning
  up to `limit` tagged-union results. A blank/whitespace query short-
  circuits to `[]` (no DB round-trip).
  """
  @spec search(String.t(), pos_integer()) :: [Result.t()]
  def search(query, limit) when is_binary(query) and is_integer(limit) and limit > 0 do
    case String.trim(query) do
      "" ->
        []

      trimmed ->
        users = Enum.map(Accounts.search_users(trimmed, limit), &user_result/1)

        visitors =
          trimmed
          |> Credentials.search_visitor_credentials_by_nick(limit)
          |> Enum.map(&visitor_result/1)

        Enum.take(users ++ visitors, limit)
    end
  end

  # A user (account) has no single network — `network: nil` (we do not
  # fabricate one); the nick shown is the account name.
  defp user_result(user) do
    %Result{type: :user, id: user.id, network: nil, nick: user.name}
  end

  # The stable key is the visitor id (from the credential's `visitor_id`
  # FK), NEVER the nick. `:network` is preloaded on the credential.
  defp visitor_result(credential) do
    %Result{
      type: :visitor,
      id: credential.visitor_id,
      network: credential.network.slug,
      nick: credential.nick
    }
  end
end
