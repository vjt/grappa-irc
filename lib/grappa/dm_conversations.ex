defmodule Grappa.DmConversations do
  @moduledoc """
  The DM conversation identity (issue 1365): one `dm_conversations` row per
  `(subject, network, folded peer nick)`, the parent every DM-keyed store
  points at by FK (`messages.dm_conversation_id`,
  `read_cursors.dm_conversation_id`).

  ## Lifecycle

    * **Minted on first contact** — the first persisted DM row
      (`Grappa.Scrollback.persist_event/1`) or the first window open
      (`Grappa.QueryWindows.open/4`), whichever comes first.
    * **Open is state**, not existence: `opened_at` is set while the query
      window is open and cleared when it closes. Closing is an UPDATE.
    * **Never deleted, never renamed.** Since the own-nick rename went to
      zero writes too, nothing re-keys a conversation: a peer or we change
      nick, and the next contact under the new nick mints its own.

  ## One folded nick, one conversation (ruling T1, 2026-09-28)

  The fold-unique index is TOTAL — open and closed rows alike — so a lookup
  is never ambiguous. The fold is `Identifier.canonical_target/1` in memory
  and `Identifier.nick_fold/1` in SQL, character-identical to the index
  expression; CLAUDE.md's rfc1459 national-char gap is inherited unchanged,
  like every other nick KEY.

  ## Leg 1: written, not yet read — leg 2: its id is published

  `query_windows` stays the source of the window list through legs 1-3 and
  this table is written beside it; no reader of a DM-keyed store consults it
  yet. Leg 2 puts the conversation id on the wire beside the nick
  (`ids_for/2`, `messages.dm_conversation_id`), looked up by the same folded
  nick every reader already keys on. What makes the
  dual write honest is that every writer of the nick-keyed stores also
  writes here, in the same transaction.

  ## Callers guarantee the subject and network exist

  No FK pre-check here: the persist path's own message insert already raises
  on a missing parent, and `QueryWindows.open/4` validates both before it
  reaches this module. A missing parent raises `Ecto.ConstraintError`.
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.IRC, Grappa.Repo, Grappa.Subject],
    exports: [Conversation]

  import Ecto.Query

  alias Grappa.DmConversations.Conversation
  alias Grappa.IRC.Identifier
  alias Grappa.{Repo, Subject}

  require Identifier

  @doc """
  The conversation whose peer folds to `nick`, minting it (closed, with
  `nick` as its display spelling) when there is none.

  Safe outside a transaction — a concurrent mint loses the insert race and
  re-selects the winner — but meant to run inside the caller's write
  transaction, so the row and its first child commit together.
  """
  @spec resolve!(Subject.t(), integer(), String.t()) :: Conversation.t()
  def resolve!({_, _} = subject, network_id, nick) when is_integer(network_id) and is_binary(nick) do
    case get(subject, network_id, nick) do
      nil -> mint!(subject, network_id, nick, nil)
      %Conversation{} = conversation -> conversation
    end
  end

  @doc """
  The conversation whose peer folds to `nick`, or `nil`.
  """
  @spec get(Subject.t(), integer(), String.t()) :: Conversation.t() | nil
  def get({_, _} = subject, network_id, nick) when is_integer(network_id) and is_binary(nick) do
    subject
    |> by_nick(network_id, Identifier.canonical_target(nick))
    |> Repo.one()
  end

  @doc """
  The id of the conversation behind each `{network_id, nick}` pair that has
  one, keyed by `{network_id, folded nick}`. A pair with no conversation is
  absent from the map; this never mints.

  Issue 1365 leg 2: what lets a window entry carry the conversation id
  beside its nick on the wire. The lookup goes BY THE FOLDED NICK, the key
  every reader still uses — no child store is read by id here. Switching the
  readers onto the FK is leg 3b, and a wire rollback must not drag it along.
  """
  @spec ids_for(Subject.t(), [{integer(), String.t()}]) :: %{{integer(), String.t()} => integer()}
  def ids_for({_, _}, []), do: %{}

  def ids_for({_, _} = subject, pairs) when is_list(pairs) do
    network_ids = pairs |> Enum.map(fn {network_id, _} -> network_id end) |> Enum.uniq()
    folds = pairs |> Enum.map(fn {_, nick} -> Identifier.canonical_target(nick) end) |> Enum.uniq()

    # Filtering the two columns independently over-fetches the cross product
    # (a fold that exists on another of the subject's networks); the map is
    # keyed on the exact pair, so the extra rows are never looked up.
    Conversation
    |> Subject.subject_where(subject)
    |> where([c], c.network_id in ^network_ids)
    |> where([c], Identifier.nick_fold(c.peer_nick) in ^folds)
    |> select([c], {c.network_id, c.peer_nick, c.id})
    |> Repo.all()
    |> Map.new(fn {network_id, peer_nick, id} -> {{network_id, Identifier.canonical_target(peer_nick)}, id} end)
  end

  @doc """
  Marks the conversation with `nick` open, minting it open when it does not
  exist. An already-open conversation keeps its `opened_at` — the
  first-opened semantics of `QueryWindows.open/4`, which it mirrors.
  """
  @spec open!(Subject.t(), integer(), String.t(), DateTime.t()) :: Conversation.t()
  def open!({_, _} = subject, network_id, nick, %DateTime{} = opened_at)
      when is_integer(network_id) and is_binary(nick) do
    case get(subject, network_id, nick) do
      nil -> mint!(subject, network_id, nick, opened_at)
      %Conversation{opened_at: nil} = conversation -> set_opened_at!(conversation, opened_at)
      %Conversation{} = conversation -> conversation
    end
  end

  @doc """
  Marks the conversation with `nick` closed. Idempotent: `:ok` whether or
  not it was open, or existed.
  """
  @spec close(Subject.t(), integer(), String.t()) :: :ok
  def close({_, _} = subject, network_id, nick) when is_integer(network_id) and is_binary(nick) do
    subject
    |> by_nick(network_id, Identifier.canonical_target(nick))
    |> Repo.update_all(set: [opened_at: nil, updated_at: now()])

    :ok
  end

  # The single folded-nick predicate, character-identical to the unique
  # expression index (`lower(peer_nick)`) so every lookup seeks it.
  @spec by_nick(Subject.t(), integer(), String.t()) :: Ecto.Query.t()
  defp by_nick(subject, network_id, folded_nick) do
    Conversation
    |> Subject.subject_where(subject)
    |> where([c], c.network_id == ^network_id)
    |> where([c], Identifier.nick_fold(c.peer_nick) == ^folded_nick)
  end

  @spec set_opened_at!(Conversation.t(), DateTime.t() | nil) :: Conversation.t()
  defp set_opened_at!(%Conversation{} = conversation, opened_at) do
    conversation
    |> Ecto.Changeset.change(opened_at: opened_at)
    |> Repo.update!()
  end

  @spec mint!(Subject.t(), integer(), String.t(), DateTime.t() | nil) :: Conversation.t()
  defp mint!(subject, network_id, nick, opened_at) do
    attrs =
      Subject.put_subject_id(
        %{network_id: network_id, peer_nick: nick, opened_at: opened_at},
        subject
      )

    inserted =
      %Conversation{}
      |> Conversation.changeset(attrs)
      |> Repo.insert!(on_conflict: :nothing, conflict_target: conflict_target(subject))

    case inserted do
      # `on_conflict: :nothing` hands back an id-less struct when a
      # concurrent mint won the race: the winner is the conversation.
      %Conversation{id: nil} ->
        subject |> by_nick(network_id, Identifier.canonical_target(nick)) |> Repo.one!()

      %Conversation{} = conversation ->
        conversation
    end
  end

  # The partial unique indexes carry `WHERE <subject>_id IS NOT NULL`, and
  # SQLite only matches an upsert target that mirrors the predicate. The fold
  # is derived from the single source, as in `QueryWindows`.
  @nick_fold_sql Identifier.nick_fold_sql("peer_nick")

  defp conflict_target({:user, _}),
    do: {:unsafe_fragment, "(user_id, network_id, #{@nick_fold_sql}) WHERE user_id IS NOT NULL"}

  defp conflict_target({:visitor, _}),
    do: {:unsafe_fragment, "(visitor_id, network_id, #{@nick_fold_sql}) WHERE visitor_id IS NOT NULL"}

  defp now, do: DateTime.truncate(DateTime.utc_now(), :second)
end
