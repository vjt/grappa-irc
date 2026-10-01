defmodule Grappa.NickMigration do
  @moduledoc """
  Single home of the nick-rename migration set (#1374 P-S2) — which, since
  issue 1365, is the OWN-nick SELF window and nothing else.

  The ruling on issue 1365 (comment 5934112501, relayed from vjt on IRC):
  a nick change, a peer's OR our own, causes NO database update; only the
  UI changes. The accepted price: a renamed peer's next message opens a NEW
  query window, and a mute is evaded by changing nick. So the PEER half of
  this module (#373 window/history/cursor, #1340 mute, #1378 probe) is gone,
  and so is the own-nick TAG re-key (#514) — `Grappa.Scrollback.Message.dm?/1`
  reads `dm_with` instead of the TAG, so the TAG may stay at the nick we held.

  The own-nick axis is RULED too ("vorrei andare a 0 anche in questo
  caso") but NOT implemented in this slice, for want of the mechanism: the
  self window (`/msg <ownnick>`, #948) is keyed on our nick, and what key
  replaces it is undecided. Until then `own_renamed/5` still moves it:

    * `Grappa.Scrollback.rename_self_window/4` — the rows.
    * `Grappa.ReadCursor.rename_dm_peer/4` — the cursor, else the moved
      history reads as fully unread.
    * `Grappa.QueryWindows.rename/4` — the window row.
    * `Grappa.UserSettings.rename_muted_target!/4` — the mute (#1340).
    * `Grappa.DmConversations.follow_rename/4` — the conversation identity:
      it follows exactly the rows the stores above moved. A rename into a
      nick that already has a conversation is a MERGE whose children move in
      bounded batches AFTER this transaction commits (`settle_conversation/3`).

  ## Why the set has a module and not just a paragraph

  Until #1374 the set existed as prose in CLAUDE.md ("A NEW nick-keyed store
  MUST be added to this migration set") over a chain inlined in
  `Grappa.Session.Server`. A new nick-keyed store was added by hoping
  somebody read the paragraph. Here the invariant is executable: the set is
  this module's public verb, and a store left out of it is visible as a
  store this module never calls.

  ## Why the transaction lives HERE

  The chain spans five contexts. None of them can host the transaction
  without owning the others' tables — an abstraction that leaks by
  construction. `Grappa.Session.Server`, the only caller, cannot host it
  either: the `Grappa.Session` boundary deliberately has no `Grappa.Repo`
  dep, and opening one to reach `immediate_transaction/1` is exactly the
  dependency its moduledoc denies. So this is a TOP-LEVEL boundary that deps
  the five contexts and `Repo`, called from Session — the
  `Grappa.SpawnOrchestrator` shape (a cross-context verb, not a supervised
  child).

  ## Composition: retry OUTSIDE, transaction INSIDE, broadcast NEITHER

  `Repo.BusyRetry.run(fn -> Repo.immediate_transaction(fn -> … end) end)`:

    * **Transaction inside** — a crash or busy between two steps used to
      strand the history under the new nick with a cursor keyed to the old
      one (the "reads as fully unread" failure the cursor move exists to
      prevent). Every store moves together or none does.
    * **Retry outside** — the whole transaction is the retryable unit. Each
      step is idempotent in the only sense that matters here: a rolled-back
      attempt left nothing behind, so a replay starts from the same
      pre-state. Callees reached from here are the non-retrying `!`
      variants where the family offers one; a nested retry would sleep
      holding the open transaction's connection.
    * **Broadcast in NEITHER** — `query_windows_list` is the truthful
      "rename fully applied" barrier and stays in `Session.Server`, after
      this returns `{:ok, _}`. Inside the retry a
      re-attempt could broadcast twice; inside the transaction it could
      announce a rename that then rolled back.

  Terminal on budget exhaustion is `{:error, :db_unavailable}`, which the
  session logs and DROPs (#590 background posture) — a rename is not worth
  disconnecting a user over, and the old-nick state it leaves behind is
  self-consistent. Before #1374 the same busy RAISED through strict
  `{:ok, _} =` binds and took the session down mid-migration.

  ## The transaction earns its place PROSPECTIVELY — do not remove it

  Today no test can kill a mutant that deletes `immediate_transaction/1`
  from `migrate/1`, and that is a property of the CURRENT step list, not a
  licence. Every step here is total on real data: the scrollback rename
  is an `update_all`, `ReadCursor.rename_dm_peer/4` handles a
  fold-collision by dropping the stale cursor, `QueryWindows.rename/4`
  merges on collision and even rescues the unique-index race, and the
  mute's changeset validates only `data` presence and the subject XOR,
  neither of which a rename of an existing row can violate. The one
  failure the chain admits — the enclosing retry's budget running out —
  fires before the first step by construction. Nothing can fail in the
  middle, so nothing can be observed rolling back.

  That changes the moment the set grows. A new store is under no obligation
  to be total — the next one may carry a validation, a unique constraint,
  or a genuine `{:error, _}` arm. On that day a half-applied identity
  becomes reachable and this transaction is the only thing standing
  between a rename and a window pointing at history that moved without
  it. It is here for the step that has not been written yet, and the
  test that will finally be able to buy it is the one that adds a
  fallible step.
  """

  use Boundary,
    top_level?: true,
    deps: [
      Grappa.DmConversations,
      Grappa.QueryWindows,
      Grappa.ReadCursor,
      Grappa.Repo,
      Grappa.Scrollback,
      Grappa.Subject,
      Grappa.UserSettings
    ]

  alias Grappa.{DmConversations, QueryWindows, ReadCursor, Repo, Scrollback, Subject, UserSettings}
  alias Grappa.Repo.BusyRetry

  require Logger

  # issue 1365 — rows re-pointed per write transaction when a rename merges
  # or splits a DM conversation. Bounded so no single lock is proportional to
  # a history: issue 2319 measured 331 rows re-keyed under one ~9.5 s lock
  # breaking an unrelated write.
  @move_batch 500

  @typedoc """
  Outcome of an own-nick rename. `rows` counts the SELF window's scrollback
  rows, and is the gate: at 0 the window, cursor and mute are deliberately
  untouched (see `own_renamed/5`).
  """
  @type own_result :: %{
          rows: non_neg_integer(),
          window: :renamed | :noop,
          mute: :renamed | :noop,
          conversation: conversation_outcome()
        }

  @typedoc """
  What the rename did to the `dm_conversations` row of the old nick (issue
  1365). It follows exactly the rows the nick-keyed stores moved, and only
  when they moved:

    * `:noop` — no rows moved, or the old nick had no conversation.
    * `:renamed` — the whole conversation moved and the new nick had none:
      one UPDATE of its display column, id unchanged.
    * `:merged` — the new nick already had a conversation; every child moved
      to it in bounded batches and the old row was deleted (ruling T1).
    * `:split` — only part of the old conversation moved (the self window
      holding history with a peer who bore our old nick): the moved children
      now point at the new nick's conversation, the rest stay.
    * `:move_incomplete` — a batch ran out of retry budget. The committed
      prefix is consistent row by row (every child points at a live parent),
      but the move stopped; logged, and the old row is kept.
  """
  @type conversation_outcome :: :noop | :renamed | :merged | :split | :move_incomplete

  @doc """
  Migrates the SELF window (`/msg <ownnick>`, #948) keyed on OUR OWN old
  nick, atomically. Ruled to go to zero writes (issue 1365) and kept only
  until a key that does not move with our nick exists — see the moduledoc.

  It moves behind its scrollback row count: a window standing at our
  old nick is EITHER our self window or a leftover query with a peer who
  bore that nick before us, and the fold-unique index makes those ONE row.
  Only the scrollback's `sender` tells them apart, so a zero count means "no
  self conversation here" and the window, cursor and mute stay put — the
  cheaper of two wrongs against filing a peer's identity under our new nick.
  """
  @spec own_renamed(Subject.t(), integer(), String.t(), String.t(), String.t()) ::
          {:ok, own_result()} | {:error, Ecto.Changeset.t() | :db_unavailable}
  def own_renamed({_, _} = subject, network_id, network_slug, old_nick, new_nick)
      when is_integer(network_id) and is_binary(network_slug) and is_binary(old_nick) and
             is_binary(new_nick) do
    fn ->
      {:ok, rows} = Scrollback.rename_self_window(subject, network_id, old_nick, new_nick)

      if rows > 0 do
        :ok = ReadCursor.rename_dm_peer(subject, network_id, old_nick, new_nick)
        {:ok, window} = QueryWindows.rename(subject, network_id, old_nick, new_nick)
        mute = UserSettings.rename_muted_target!(subject, network_slug, old_nick, new_nick)
        conversation = follow_conversation(subject, network_id, old_nick, new_nick)

        %{rows: rows, window: window, mute: mute, conversation: conversation}
      else
        %{rows: 0, window: :noop, mute: :noop, conversation: :noop}
      end
    end
    |> migrate()
    |> settle_conversation(old_nick, new_nick)
  end

  # One retried write transaction — the migration itself, and each batch of a
  # conversation move after it.
  @spec migrate((-> result)) :: {:ok, result} | {:error, Ecto.Changeset.t() | :db_unavailable}
        when result: term()
  defp migrate(fun) do
    BusyRetry.run(fn -> Repo.immediate_transaction(fun) end)
  end

  # issue 1365 — the conversation half of a rename, inside the migration
  # transaction and AFTER the scrollback moved: what `follow_rename/4` has to
  # decide is which conversation the moved rows now belong to, and only the
  # post-move rows can say whether the old conversation still has any of its
  # own.
  @spec follow_conversation(Subject.t(), integer(), String.t(), String.t()) ::
          :noop | DmConversations.follow()
  defp follow_conversation(subject, network_id, old_nick, new_nick) do
    case DmConversations.get(subject, network_id, old_nick) do
      nil ->
        :noop

      source ->
        keeps_rows? = Scrollback.dm_conversation_keyed?(source.id, old_nick)
        DmConversations.follow_rename(subject, source, new_nick, keeps_rows?)
    end
  end

  # A merge or split re-points its children AFTER the migration committed, in
  # bounded write transactions of their own — never inside the migration's,
  # whose lock would then grow with the conversation (ruling T1: "bounded
  # batches, never as one long write transaction"). Between the commit and
  # the last batch a moved row still points at the old conversation, which
  # is still a live parent, and no reader consults the FK in leg 1.
  @spec settle_conversation({:ok, map()} | {:error, term()}, String.t(), String.t()) ::
          {:ok, map()} | {:error, term()}
  defp settle_conversation({:ok, %{conversation: {:move, from_id, to_id}} = result}, old_nick, new_nick) do
    {:ok, %{result | conversation: move_rows(from_id, to_id, old_nick, new_nick)}}
  end

  defp settle_conversation(other, _, _), do: other

  @spec move_rows(pos_integer(), pos_integer(), String.t(), String.t()) :: conversation_outcome()
  defp move_rows(from_id, to_id, old_nick, new_nick) do
    batch = migrate(fn -> Scrollback.move_dm_conversation_rows(from_id, to_id, new_nick, @move_batch) end)

    case batch do
      {:ok, @move_batch} -> move_rows(from_id, to_id, old_nick, new_nick)
      {:ok, _} -> finish_move(from_id, to_id, old_nick, new_nick)
      {:error, :db_unavailable} -> move_incomplete(old_nick, new_nick)
    end
  end

  # The cursor and the delete share one transaction, so "no child left" is
  # proved under the same lock that deletes the parent.
  @spec finish_move(pos_integer(), pos_integer(), String.t(), String.t()) :: conversation_outcome()
  defp finish_move(from_id, to_id, old_nick, new_nick) do
    finished =
      migrate(fn ->
        ReadCursor.move_dm_conversation(from_id, to_id, new_nick)

        if Scrollback.dm_conversation_rows?(from_id) or ReadCursor.dm_conversation_cursor?(from_id) do
          :split
        else
          :ok = DmConversations.delete!(from_id)
          :merged
        end
      end)

    case finished do
      {:ok, outcome} -> outcome
      {:error, :db_unavailable} -> move_incomplete(old_nick, new_nick)
    end
  end

  @spec move_incomplete(String.t(), String.t()) :: :move_incomplete
  defp move_incomplete(old_nick, new_nick) do
    Logger.warning(
      "DM conversation move stopped: db unavailable — some rows still point at the old nick's conversation",
      old_nick: old_nick,
      new_nick: new_nick
    )

    :move_incomplete
  end
end
