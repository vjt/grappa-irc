defmodule GrappaWeb.Subject do
  @moduledoc """
  Web-layer subject discriminator (M-web-1).

  `GrappaWeb.Plugs.Authn` assigns a single `:current_subject` tagged
  tuple carrying the loaded subject struct:

      {:user, %Grappa.Accounts.User{}} | {:visitor, %Grappa.Visitors.Visitor{}}

  This is the controller-side view: rich enough that consumers don't
  re-fetch and don't drift from a parallel `:current_user` /
  `:current_visitor` assign (which is what M-web-1 closes — the
  KeyError race when one is set and the other isn't).

  The Session / Scrollback boundary (`t:Grappa.Session.subject/0`) speaks
  the leaner `{:user, id} | {:visitor, id}` shape; controllers
  delegating downstream call `to_session/1` to convert.
  """

  alias Grappa.Accounts.User
  alias Grappa.Visitors.Visitor

  # Single source of the visitor topic-label prefix (bucket I web/S7).
  # `topic_label/1` builds it, `from_topic_label/1` strips it — both
  # reference this one literal so the load-bearing routing invariant
  # ("user → `user.name`, visitor → `"visitor:" <> id`") can never fork
  # between the producing and consuming directions.
  #
  # Scope note: this single-sources the WEB boundary. The `Grappa` core
  # boundary derives the same label independently (`Networks`,
  # `Visitors.SessionPlan`) — it MUST, since the Boundary graph runs
  # web → core and `GrappaWeb.Subject` is unreachable from core. A
  # label-shape change touches both this module and the core sites.
  @visitor_prefix "visitor:"

  @typedoc "Web-layer subject — carries the loaded struct."
  @type t :: {:user, User.t()} | {:visitor, Visitor.t()}

  @doc """
  Convert a web-layer subject tuple to the Session/Scrollback boundary
  shape (`t:Grappa.Session.subject/0` — bare-id tuple).
  """
  @spec to_session(t()) :: Grappa.Session.subject()
  def to_session({:user, %User{id: id}}), do: {:user, id}
  def to_session({:visitor, %Visitor{id: id}}), do: {:visitor, id}

  @doc """
  Derive the user_name segment of a `Grappa.PubSub.Topic` from a
  web-layer subject (bucket I web/S7 — single source).

  Users map to their bare `user.name`; visitors map to
  `"visitor:" <> visitor.id`. This MUST match the `:user_name` assign
  `GrappaWeb.UserSocket.connect/3` installs at connect time — every
  cross-device broadcast (`ReadCursor.broadcast_set/5`, archive
  invalidations, `notify_list`, …) routes on the topic built from this
  label, so a mismatch would silently miss the subject's own topic.

  A `nil` user name is an invariant violation (an authenticated user
  always has a name; the schema types the field nilable only for the
  pre-insert changeset window) and raises `FunctionClauseError` rather
  than building the malformed `"grappa:user:"` topic — fail loud, per
  the boundary-rejection rule.
  """
  @spec topic_label(t()) :: String.t()
  def topic_label({:user, %User{name: name}}) when is_binary(name), do: name
  def topic_label({:visitor, %Visitor{id: id}}) when is_binary(id), do: @visitor_prefix <> id

  @doc """
  Classify a topic-label string back into its subject discriminant —
  the inverse of `topic_label/1` on the label alone (bucket I web/S7).

  `"visitor:" <> id` decodes to `{:visitor, id}`; any other string is a
  `{:user, name}`. Returns the classified *label* parts, NOT a loaded
  subject: the user branch yields the bare name for the caller to
  DB-resolve (a deleted-row race is that caller's concern, e.g.
  `GrappaWeb.GrappaChannel.resolve_subject/1`). Sharing the
  `@visitor_prefix` with `topic_label/1` is the whole point — the
  producing and consuming sides can never disagree on the prefix.
  """
  @spec from_topic_label(String.t()) :: {:user, String.t()} | {:visitor, String.t()}
  def from_topic_label(@visitor_prefix <> id), do: {:visitor, id}
  def from_topic_label(name) when is_binary(name), do: {:user, name}
end
