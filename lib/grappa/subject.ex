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
    deps: [Grappa.Accounts, Grappa.Visitors.Visitor]

  import Ecto.Query

  alias Grappa.Accounts.User
  alias Grappa.Visitors.Visitor

  @typedoc "Bare-id subject tuple — the wire shape between non-web contexts."
  @type t :: {:user, Ecto.UUID.t()} | {:visitor, Ecto.UUID.t()}

  @typedoc """
  Subject-label parts — the user-rooted topic-label decomposed.

  The user branch carries the `user.name` (NOT the id, unlike `t/0`),
  the visitor branch carries the `visitor.id`. This is what `label/1`
  encodes and `from_label/1` decodes; the user branch is a bare name
  the caller DB-resolves (a deleted-row race is the caller's concern).
  """
  @type label_parts :: {:user, String.t()} | {:visitor, String.t()}

  # Single source of the visitor label prefix (#413). Both `label/1`
  # and `from_label/1` reference this one literal, so the load-bearing
  # routing invariant ("user → `user.name`, visitor → `"visitor:" <>
  # id`") can never fork between the producing and consuming
  # directions. `GrappaWeb.Subject` delegates here rather than keeping
  # a parallel prefix — one codec, both boundaries.
  @visitor_prefix "visitor:"

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
  Adds a `WHERE user_id = ?` clause (or its visitor mirror) to
  `queryable`.

  Only the one equality — NOT the `AND visitor_id IS NULL` this
  docstring used to promise, which no spelling of the helper has ever
  emitted. The second conjunct is redundant under the DB-level XOR
  CHECK, so the omission is correct; the sentence was not, and it is
  the sentence a reader reaches for when reasoning about subject
  isolation (#1392).

  The only spelling of this predicate. `Grappa.Scrollback` and
  `Grappa.ReadCursor` kept private synonyms until #1392 folded them
  here, which is what the V1 promotion had claimed since it landed.

  Uses positional binding `[row]`, so the precondition is that
  **binding 0 carries the subject FK** — not that the query has a
  single from-binding, as this docstring used to say.
  `ReadCursor.bulk_for_subject/1` joins `networks` and has always been
  a correct caller: the join is at position 1, the cursor at 0. A
  caller whose subject-scoped table is NOT the from-binding must write
  the where-clause directly.
  """
  @spec subject_where(Ecto.Queryable.t(), t()) :: Ecto.Query.t()
  def subject_where(queryable, {:user, user_id}) when is_binary(user_id),
    do: where(queryable, [row], row.user_id == ^user_id)

  def subject_where(queryable, {:visitor, visitor_id}) when is_binary(visitor_id),
    do: where(queryable, [row], row.visitor_id == ^visitor_id)

  # B5.4 L-pers-2, promoted from `Grappa.Scrollback` by #1392: explicit
  # fall-through replaces an implicit FunctionClauseError (Erlang-level
  # message hides both the offending value and the function name).
  # ArgumentError carries the inspected subject so caller bugs (typo
  # `:users` for `:user`, `nil` from a stale ref, leftover atom from a
  # refactor) surface with actionable diagnostics.
  #
  # This clause is why the fold is not a deletion. Retiring the two
  # private spellings without it would have stripped the diagnostic
  # from Scrollback's 12 call sites; carrying it along instead moves
  # the other 26 UP to it, which is a behaviour change in the fail-loud
  # direction and is named as one.
  #
  # `put_subject_id/2` deliberately keeps the bare FunctionClauseError:
  # giving it this clause too is a second behaviour change across its
  # own call sites that nothing has asked for, and a hard failure on a
  # malformed shape is already the right answer.
  def subject_where(_, other),
    do: raise(ArgumentError, "unknown subject: #{inspect(other)}")

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

  @doc """
  Encode subject-label parts into the user-rooted topic-label string
  (#413) — the single source of the "user → `user.name`, visitor →
  `"visitor:" <> id`" invariant every non-web context and
  `GrappaWeb.Subject.topic_label/1` used to restate independently.

  Users map to their bare `user.name`; visitors to
  `"visitor:" <> visitor.id`. This is the `:user_name` segment of a
  `Grappa.PubSub.Topic` — every cross-device broadcast routes on the
  topic built from it, so encode and decode MUST NOT drift (the
  silent dead-drop this codec exists to prevent). Bare strings in,
  never structs: the caller extracts `name`/`id` from whatever it
  holds (`%User{}`, `%Visitor{}`, `%Credential{}` FK) and passes the
  parts — keeping this a core-boundary string codec both web and core
  can reach.
  """
  @spec label(label_parts()) :: String.t()
  def label({:user, name}) when is_binary(name), do: name
  def label({:visitor, id}) when is_binary(id), do: @visitor_prefix <> id

  @doc """
  Decode a topic-label string back into its subject-label parts
  (#413) — the inverse of `label/1` on the label alone.

  `"visitor:" <> id` decodes to `{:visitor, id}`; any other string is
  a `{:user, name}`. Returns the classified *label* parts, NOT a
  loaded subject: the user branch yields the bare name for the caller
  to DB-resolve. Sharing `@visitor_prefix` with `label/1` is the
  whole point — the producing and consuming sides can never disagree
  on the prefix. Total by construction: valid `user.name`s
  (`^[a-zA-Z][a-zA-Z0-9_\\-]*$`) never contain a colon, so a bare name
  can never collide with the visitor prefix.
  """
  @spec from_label(String.t()) :: label_parts()
  def from_label(@visitor_prefix <> id), do: {:visitor, id}
  def from_label(name) when is_binary(name), do: {:user, name}
end
