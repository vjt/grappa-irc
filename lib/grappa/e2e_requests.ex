defmodule Grappa.E2eRequests do
  @moduledoc """
  Asking a peer to start an end-to-end encrypted chat, and the answer,
  kept server-side (issue 2486, vjt's ruling: design B, with CANCEL).

  The key exchange already completes while the two clients are never
  online together: grappa answers a KEYREQ from the bundles the devices
  uploaded, and PKMSG/MSG wait in each device's offline queue
  (`Grappa.E2eInbox`). What was missing is CONSENT: this context keeps it.
  One row per (subject, network, folded peer), whichever side asked, in
  one of four stored states (`Grappa.E2eRequests.Request`):

    * `incoming` — the peer asked us (their REQUEST arrived);
    * `outgoing` — we asked the peer (our REQUEST went out);
    * `accepted` / `refused` — the peer's answer to our asking, kept until
      a client has shown it: an offline requester must still see it when
      it comes back.

  A pending row (`incoming`, `outgoing`) lapses `ttl_seconds/0` after it
  entered its state (`expired?/2`), for everyone: grappa cannot know which
  client the peer runs, so the deadline is the only "no answer". An
  expired `outgoing` row stays, read as `expired`, until it is retried or
  dismissed; an expired `incoming` one is no longer listed, and
  `expire/3` deletes it.

  ## The transitions, by verb alone

  The state machine is driven by the VERB of the line, which grappa sees in
  the outer frame; the payload is opaque and never parsed (crypto
  layering). Each transition is planned by a pure function (`inbound/5`,
  `ask/3`, `answer/2`, `dismiss/2`) and carried out by `commit/4`, so the
  session can let the pacer accept the line FIRST and write the row only
  then: a refused send leaves no state behind.

  | row (as of now)        | event                  | to                          |
  |------------------------|------------------------|-----------------------------|
  | none / expired / lapsed incoming / refused | REQUEST arrives | `incoming` (fresh: told) |
  | `incoming`             | REQUEST arrives        | `incoming`, refreshed, not told again |
  | `outgoing`             | REQUEST arrives        | `accepted` + ACCEPT answered: their request is their consent |
  | `accepted`             | REQUEST arrives        | stays + ACCEPT answered: consent is already given |
  | `outgoing`             | ACCEPT / REFUSE arrives | `accepted` / `refused`     |
  | (lapsed) `incoming`    | CANCEL arrives         | gone                        |
  | anything else          | ACCEPT/REFUSE/CANCEL   | dropped: nobody asked       |
  | `incoming`             | user asks that peer    | `accepted` + ACCEPT sent: our request is our consent |
  | anything else          | user asks              | `outgoing` + REQUEST sent (a fresh deadline) |
  | `incoming`             | user accepts / refuses | gone + ACCEPT / REFUSE sent (a REFUSE from `*` without a device) |
  | `outgoing`             | user dismisses         | gone + CANCEL sent          |
  | expired / `accepted` / `refused` / lapsed incoming | user dismisses | gone |

  A late ACCEPT or REFUSE (past our deadline) finds an expired row and is
  dropped: nobody is asking any more.

  "ACCEPT answered" (vjt's ruling R1): a REQUEST that meets our consent is
  answered by grappa itself, one ACCEPT from `*` (it speaks for the user)
  to the device that asked, so the peer hears it even if our own REQUEST
  never reached them. An expired asking is no consent. An ACCEPT is never
  answered, so on a crossing each side drops the other's as unsolicited
  and the exchange cannot loop.

  The row keeps the device the peer's latest line came from
  (`Request.peer_device`): a REFUSE the user gives without a device of
  its own goes there, from `*` (vjt's ruling R2), so saying no never needs
  an encryption identity. Asking afresh forgets it; asking a peer whose
  request waits keeps it.

  ## Bounds that keep strangers out

  At most `max_rows/0` rows the peers started (`incoming`, and one past its
  deadline takes no room, swept or not) and as many we started
  (`outgoing`, `accepted`, `refused`) per subject and network; past that a
  new nick's REQUEST is dropped, and a new ask refused. Ours never lapse:
  only a dismissal frees a room on our side. One row per
  folded peer, so a nick that asks again refreshes its row. A payload is at
  most `Request.max_payload_bytes/0`.

  ## Keyed by nick

  The peer's nick is the only identity grappa sees here (it holds no key),
  so it is the KEY, folded like `query_windows.target_nick`. A rename moves
  nothing (CLAUDE.md, issue 1365): a request made under the old nick stays
  there and lapses, the same accepted price a renamed peer's query window
  pays.

  ## Boundary

  Deps: `Grappa.IRC` (the nick fold and the payload's character rule),
  `Grappa.Repo`, `Grappa.Subject`.
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.IRC, Grappa.Repo, Grappa.Subject],
    exports: [Request, Wire]

  import Ecto.Query

  alias Grappa.E2eRequests.Request
  alias Grappa.IRC.{E2e, Identifier}
  alias Grappa.{Repo, Subject}

  require Identifier

  @ttl_seconds 24 * 60 * 60
  @max_rows 32

  # The states each side started: the cap is per side.
  @theirs [:incoming]
  @ours [:outgoing, :accepted, :refused]

  @typedoc "Why an inbound line changed nothing."
  @type drop_reason :: :unsolicited | :already_accepted

  @typedoc """
  What a `:put` writes: the peer as spelled on this event, the state, the
  payload, and the device of the peer's latest line (`Request.peer_device`).
  """
  @type put :: %{
          peer: String.t(),
          state: Request.state(),
          payload: String.t() | nil,
          peer_device: E2e.address() | nil
        }

  @typedoc """
  What a transition does to the table, planned without touching it;
  `commit/4` carries it out. A `:put` names the row it replaces (or `nil`)
  and what it writes.
  """
  @type plan :: {:put, Request.t() | nil, put()} | {:delete, Request.t()} | {:drop, drop_reason()}

  @typedoc """
  What `commit/4` did. A `:put` says whether the request is FRESH: an
  `incoming` one the user has not been told about (none before, or one
  that had lapsed or changed state), which is pushed and opens the query.
  """
  @type outcome :: {:put, Request.t(), fresh :: boolean()} | {:delete, Request.t()} | {:drop, drop_reason()}

  # A row as of an instant: its stored state, or the two lapsed forms.
  @typep phase :: Request.state() | :expired | :lapsed

  @doc "How long a pending request waits for an answer: 24 h, vjt's ruling."
  @spec ttl_seconds() :: 86_400
  def ttl_seconds, do: @ttl_seconds

  @doc "The most rows each side may have started, per subject and network."
  @spec max_rows() :: 32
  def max_rows, do: @max_rows

  @doc """
  The requests of `subject` on `network_id` as of `now`, oldest first. An
  `incoming` one past its deadline is not listed.
  """
  @spec list(Subject.t(), integer(), DateTime.t()) :: [Request.t()]
  def list({_, _} = subject, network_id, %DateTime{} = now) when is_integer(network_id) do
    subject
    |> partition(network_id)
    |> order_by([r], asc: r.id)
    |> Repo.all()
    |> Enum.reject(&(phase(&1, now) == :lapsed))
  end

  @doc "The request `id` of `subject` on `network_id`, or `nil`: another subject's is out of reach."
  @spec get(Subject.t(), integer(), integer()) :: Request.t() | nil
  def get({_, _} = subject, network_id, id) when is_integer(network_id) and is_integer(id),
    do: subject |> partition(network_id) |> where([r], r.id == ^id) |> Repo.one()

  @doc "The request between `subject` and `peer` on `network_id`, folded, or `nil`."
  @spec for_peer(Subject.t(), integer(), String.t()) :: Request.t() | nil
  def for_peer({_, _} = subject, network_id, peer) when is_integer(network_id) and is_binary(peer) do
    folded = Identifier.canonical_target(peer)
    subject |> partition(network_id) |> where([r], Identifier.nick_fold(r.peer) == ^folded) |> Repo.one()
  end

  @doc """
  True iff `payload` may ride a consent line: compact JSON text
  (`E2e.chunk?/1`) of at most `Request.max_payload_bytes/0`. The one rule,
  for the send door and the inbound line alike.
  """
  @spec payload?(term()) :: boolean()
  def payload?(payload) when is_binary(payload),
    do: byte_size(payload) <= Request.max_payload_bytes() and E2e.chunk?(payload)

  def payload?(_), do: false

  @doc "True for a pending request (`incoming`, `outgoing`) past its deadline at `now`."
  @spec expired?(Request.t(), DateTime.t()) :: boolean()
  def expired?(%Request{} = request, %DateTime{} = now), do: phase(request, now) in [:expired, :lapsed]

  @doc "The deadline of a pending request; `nil` on an answer, which waits until it is shown."
  @spec expires_at(Request.t()) :: DateTime.t() | nil
  def expires_at(%Request{state: state, updated_at: at}) when state in [:incoming, :outgoing],
    do: DateTime.add(at, @ttl_seconds, :second)

  def expires_at(%Request{}), do: nil

  @doc """
  Plans what an inbound consent line from `peer` does, given the row the
  subject holds with that peer (or `nil`), and whether grappa answers it
  ACCEPT for the user: a REQUEST that meets our consent, our live
  `outgoing` request or an `accepted` row. Pure. The line is the device it
  came from (the frame's `from`) and its payload, already checked
  (`E2e.chunk?/1`, at most `Request.max_payload_bytes/0`).
  """
  @spec inbound(Request.t() | nil, E2e.consent_verb(), String.t(), {E2e.address(), String.t()}, DateTime.t()) ::
          {:accept | :none, plan()}
  def inbound(row, verb, peer, {device, payload}, %DateTime{} = now)
      when is_binary(peer) and is_binary(device) and is_binary(payload) do
    to = fn state -> {:put, row, %{peer: peer, state: state, payload: payload, peer_device: device}} end
    transition(verb, phase(row, now), row, to)
  end

  # The inbound table: the verb, the row's phase, and `to`, which writes the
  # row in a state with the line's peer, payload and device. A REQUEST on
  # anything but our consent (a live `incoming` asking again included) is
  # their asking afresh.
  @spec transition(E2e.consent_verb(), phase() | nil, Request.t() | nil, (Request.state() -> plan())) ::
          {:accept | :none, plan()}
  defp transition(:request, :outgoing, _, to), do: {:accept, to.(:accepted)}
  defp transition(:request, :accepted, _, _), do: {:accept, {:drop, :already_accepted}}
  defp transition(:request, _, _, to), do: {:none, to.(:incoming)}
  defp transition(:accept, :outgoing, _, to), do: {:none, to.(:accepted)}
  defp transition(:refuse, :outgoing, _, to), do: {:none, to.(:refused)}
  defp transition(:cancel, phase, row, _) when phase in [:incoming, :lapsed], do: {:none, {:delete, row}}
  defp transition(_, _, _, _), do: {:none, {:drop, :unsolicited}}

  @doc """
  Plans the user asking `peer` for an encrypted chat. Pure. A live
  `incoming` request from that peer is their consent, so asking answers it:
  ACCEPT goes out and the row reads `accepted`, as when their REQUEST meets
  our `outgoing`, and keeps the device their asking came from. Otherwise
  REQUEST goes out and the row reads `outgoing` with a fresh deadline and
  no line of theirs: asking again, or after an expiry or a refusal, is a
  new request.
  """
  @spec ask(Request.t() | nil, String.t(), DateTime.t()) :: {:request | :accept, plan()}
  def ask(row, peer, %DateTime{} = now) when is_binary(peer) do
    case phase(row, now) do
      :incoming ->
        {:accept, {:put, row, %{peer: peer, state: :accepted, payload: row.payload, peer_device: row.peer_device}}}

      _ ->
        {:request, {:put, row, %{peer: peer, state: :outgoing, payload: nil, peer_device: nil}}}
    end
  end

  @doc """
  Plans the user accepting or refusing `row`. Pure. Only a live `incoming`
  request is answered, and the row goes. `{:error, :not_found}` for one
  past its deadline (it is no longer listed), `{:error, :request_state}` for any
  other state.
  """
  @spec answer(Request.t(), DateTime.t()) :: {:ok, plan()} | {:error, :not_found | :request_state}
  def answer(%Request{} = row, %DateTime{} = now) do
    case phase(row, now) do
      :incoming -> {:ok, {:delete, row}}
      :lapsed -> {:error, :not_found}
      _ -> {:error, :request_state}
    end
  end

  @doc """
  Plans the user dismissing `row`. Pure. A live `outgoing` request is
  cancelled (CANCEL goes out, so the peer's banner goes too); an expired
  one, an answer or a lapsed `incoming` one just goes. `{:error, :request_state}`
  for a live `incoming` request: that one is answered, not dismissed.
  """
  @spec dismiss(Request.t(), DateTime.t()) :: {:cancel | :none, plan()} | {:error, :request_state}
  def dismiss(%Request{} = row, %DateTime{} = now) do
    case phase(row, now) do
      :incoming -> {:error, :request_state}
      :outgoing -> {:cancel, {:delete, row}}
      _ -> {:none, {:delete, row}}
    end
  end

  @doc """
  Carries out `plan` for `subject` on `network_id`, at `now`.

  `{:error, :requests_full}` when a `:put` would start a row on a side that already
  has `max_rows/0` (the check and the write are one transaction);
  `{:error, :db_unavailable}` when the write lock stays taken past the
  retry budget. A `:drop` touches nothing.
  """
  @spec commit(Subject.t(), integer(), plan(), DateTime.t()) ::
          {:ok, outcome()} | {:error, :requests_full | :db_unavailable}
  def commit({_, _}, network_id, {:drop, reason}, _) when is_integer(network_id), do: {:ok, {:drop, reason}}

  def commit({_, _} = subject, network_id, {:delete, %Request{id: id} = row}, _) when is_integer(network_id) do
    query = subject |> partition(network_id) |> where([r], r.id == ^id)

    case Repo.BusyRetry.run(fn -> {:ok, Repo.delete_all(query)} end) do
      {:ok, {_, _}} -> {:ok, {:delete, row}}
      {:error, :db_unavailable} = err -> err
    end
  end

  def commit({_, _} = subject, network_id, {:put, row, %{state: state} = attrs}, %DateTime{} = now)
      when is_integer(network_id) do
    at = DateTime.truncate(now, :second)
    fresh? = state == :incoming and phase(row, now) != :incoming

    changeset =
      Request.changeset(
        row || %Request{inserted_at: at},
        Subject.put_subject_id(Map.merge(attrs, %{network_id: network_id, updated_at: at}), subject)
      )

    case Repo.BusyRetry.run(fn -> put_transaction(subject, network_id, {row, state, changeset}, now) end) do
      {:ok, request} -> {:ok, {:put, request, fresh?}}
      {:error, _} = err -> err
    end
  end

  @spec put_transaction(
          Subject.t(),
          integer(),
          {Request.t() | nil, Request.state(), Ecto.Changeset.t()},
          DateTime.t()
        ) :: {:ok, Request.t()} | {:error, :requests_full}
  defp put_transaction(subject, network_id, write, now),
    do: Repo.immediate_transaction(fn -> put(subject, network_id, write, now) end)

  # Inside the transaction: the room check when the row starts on a side it
  # was not on, then the write. A changeset error is a broken invariant (the
  # session checked the peer and the payload), so it raises.
  @spec put(Subject.t(), integer(), {Request.t() | nil, Request.state(), Ecto.Changeset.t()}, DateTime.t()) ::
          Request.t()
  defp put(subject, network_id, {row, state, changeset}, now) do
    side = side(state)

    if (is_nil(row) or side(row.state) != side) and count(subject, network_id, side, now) >= @max_rows,
      do: Repo.rollback(:requests_full),
      else: Repo.insert_or_update!(changeset)
  end

  # The rows taking a room on `side` at `now`. An incoming row past its
  # deadline takes none: it is listed no more, and the sweep deletes it
  # within the hour. Ours keep theirs until dismissed.
  @spec count(Subject.t(), integer(), [Request.state()], DateTime.t()) :: non_neg_integer()
  defp count(subject, network_id, @theirs, now) do
    cutoff = DateTime.add(now, -@ttl_seconds, :second)

    subject
    |> partition(network_id)
    |> where([r], r.state in ^@theirs and r.updated_at > ^cutoff)
    |> select([r], count(r.id))
    |> Repo.one()
  end

  defp count(subject, network_id, @ours, _),
    do: subject |> partition(network_id) |> where([r], r.state in ^@ours) |> select([r], count(r.id)) |> Repo.one()

  @doc """
  Deletes the `incoming` requests of `subject` on `network_id` past their
  deadline at `now`, and returns them, so the session can tell every
  device the banner is gone. The write lock is taken only when something
  has lapsed: every session sweeps at start.
  """
  @spec expire(Subject.t(), integer(), DateTime.t()) :: {:ok, [Request.t()]} | {:error, :db_unavailable}
  def expire({_, _} = subject, network_id, %DateTime{} = now) when is_integer(network_id) do
    cutoff = DateTime.add(now, -@ttl_seconds, :second)
    lapsed = subject |> partition(network_id) |> where([r], r.state == :incoming and r.updated_at <= ^cutoff)

    case Repo.all(lapsed) do
      [] -> {:ok, []}
      [_ | _] -> Repo.BusyRetry.run(fn -> delete_lapsed(lapsed) end)
    end
  end

  # Read again inside the lock, then delete the same set: a REQUEST may
  # have refreshed a row since the read outside it. Nothing inside rolls
  # back, so the transaction can only commit; a raise (a busy lock)
  # propagates to `BusyRetry` as it would anyway.
  @spec delete_lapsed(Ecto.Query.t()) :: {:ok, [Request.t()]}
  defp delete_lapsed(lapsed) do
    {:ok, deleted} =
      Repo.immediate_transaction(fn ->
        rows = Repo.all(lapsed)
        {_, _} = Repo.delete_all(lapsed)
        rows
      end)

    {:ok, deleted}
  end

  @spec partition(Subject.t(), integer()) :: Ecto.Query.t()
  defp partition(subject, network_id),
    do: Request |> Subject.subject_where(subject) |> where([r], r.network_id == ^network_id)

  @spec side(Request.state()) :: [Request.state(), ...]
  defp side(state) when state in @theirs, do: @theirs
  defp side(state) when state in @ours, do: @ours

  @spec phase(Request.t() | nil, DateTime.t()) :: phase() | nil
  defp phase(nil, _), do: nil

  defp phase(%Request{state: state} = request, now) when state in [:incoming, :outgoing] do
    cond do
      DateTime.compare(now, expires_at(request)) == :lt -> state
      state == :outgoing -> :expired
      true -> :lapsed
    end
  end

  defp phase(%Request{state: state}, _), do: state
end
