defmodule Grappa.Subject do
  @moduledoc """
  Context-boundary subject helper — single source of truth for the
  `{:user, uuid} | {:visitor, uuid}` discriminator across non-web
  contexts (Scrollback, QueryWindows, Push, UserSettings, ReadCursor,
  Session, Mentions, …).

  ## Two layers, one truth

    * `GrappaWeb.Subject` (`lib/grappa_web/subject.ex`) — controller-side
      rich-struct shape `{:user, %User{}} | {:visitor, %Visitor{}}` with
      `to_session/1` to drop to the bare-id tuple.
    * `Grappa.Subject` (this module) — context-side bare-id tuple shape.
      Exposes `put_subject_id/2`, `subject_where/2`, `from_assigns/1`.

  ## Invariant

  Every persistence-write codepath for subject-scoped tables
  (`messages`, `read_cursors`, `query_windows`, `push_subscriptions`,
  `user_settings`, `accounts_sessions`) builds its changeset via
  `put_subject_id/2` — never inlines `%{user_id: ...}` or
  `%{visitor_id: ...}` literally. The XOR CHECK constraint at the DB
  level enforces this at the substrate; this helper enforces it at the
  call-site.

  Promoted from `Grappa.Session.put_subject_id/2` (visitor-parity
  cluster V1) so callers no longer take a Boundary dep on
  `Grappa.Session` just to put a subject FK on a changeset attrs map.
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.Accounts],
    dirty_xrefs: [Grappa.Visitors.Visitor]

  import Ecto.Query

  alias Grappa.Accounts.User
  alias Grappa.Visitors.Visitor

  @typedoc "Bare-id subject tuple — the wire shape between non-web contexts."
  @type t :: {:user, Ecto.UUID.t()} | {:visitor, Ecto.UUID.t()}

  @doc """
  Adds the correct subject FK column to a changeset attrs map.

  `:user_id` for `{:user, _}` subjects, `:visitor_id` for
  `{:visitor, _}` subjects. The XOR invariant means exactly one of
  the two columns is set on every row.
  """
  @spec put_subject_id(map(), t()) :: map()
  def put_subject_id(attrs, {:user, uid}) when is_map(attrs) and is_binary(uid),
    do: Map.put(attrs, :user_id, uid)

  def put_subject_id(attrs, {:visitor, vid}) when is_map(attrs) and is_binary(vid),
    do: Map.put(attrs, :visitor_id, vid)

  @doc """
  Adds a `WHERE user_id = ? AND visitor_id IS NULL`-shaped clause
  (or its visitor mirror) to `queryable`.

  Mirror of the per-context private `subject_where/2` helpers in
  `Grappa.Scrollback` and `Grappa.ReadCursor` — promoted to the
  shared boundary so new contexts (V1: query_windows, push,
  user_settings) don't each grow their own copy.

  Uses positional binding `[row]` — the queryable must have a
  single from-binding (the common case for context-internal
  filters). Multi-join callers should write the where-clause
  directly.
  """
  @spec subject_where(Ecto.Queryable.t(), t()) :: Ecto.Query.t()
  def subject_where(queryable, {:user, user_id}) when is_binary(user_id),
    do: where(queryable, [row], row.user_id == ^user_id)

  def subject_where(queryable, {:visitor, visitor_id}) when is_binary(visitor_id),
    do: where(queryable, [row], row.visitor_id == ^visitor_id)

  @doc """
  Resolves the bare-id subject from `Plug.Conn.assigns`.

  Reads `:current_subject` (set by `GrappaWeb.Plugs.Authn`), drops
  to the session-shape via the same conversion as
  `GrappaWeb.Subject.to_session/1`. `nil` when no subject is
  assigned (unauthenticated requests).
  """
  @spec from_assigns(map()) :: t() | nil
  def from_assigns(%{current_subject: {:user, %User{} = u}}), do: {:user, u.id}
  def from_assigns(%{current_subject: {:visitor, %Visitor{} = v}}), do: {:visitor, v.id}
  def from_assigns(_), do: nil
end
