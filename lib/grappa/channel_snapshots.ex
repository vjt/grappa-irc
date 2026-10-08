defmodule Grappa.ChannelSnapshots do
  @moduledoc """
  Channel-membership snapshots, one per 366 RPL_ENDOFNAMES (issue 2348).

  The archive records JOIN/PART/QUIT/NICK/KICK deltas but never the set
  they apply to, so anything that rebuilds "who is in the channel" from it
  replays deltas from an unknown starting point, and every session gap
  loses the QUITs that fell inside it. A snapshot at each 366 — every join
  and every reconnect, because a self-JOIN resets the channel's roster and
  a reconnect is a fresh `Session.Server` — gives such a reader a point to
  reset to.

  Nothing inside grappa reads these rows: there is no wire shape, no
  renderer and no scrollback change. The consumer is the archive-based
  stats daemon outside this repo. Append-only (vjt, issue 2348 Q1).
  """

  use Boundary,
    top_level?: true,
    deps: [Grappa.Repo, Grappa.Subject],
    exports: [Snapshot]

  alias Grappa.ChannelSnapshots.Snapshot
  alias Grappa.{Repo, Subject}
  alias Grappa.Repo.BusyRetry

  @doc """
  Records the roster `members` (the session's `nick => modes` map for
  `channel`) as one snapshot row at `ts` (epoch ms).

  The caller has already established that the session is joined to
  `channel`: a 366 answering `/names` on a channel we are not in carries
  no roster of ours and must never reach here.

  The insert rides `Grappa.Repo.BusyRetry`: the caller is a
  `Session.Server`, and a write-lock wait that outlasts the retry budget
  comes back as `{:error, :db_unavailable}` for it to log, instead of a
  raise that would drop the upstream link.
  """
  @spec record(Subject.t(), integer(), String.t(), %{String.t() => [String.t()]}, integer()) ::
          {:ok, Snapshot.t()} | {:error, Ecto.Changeset.t() | :db_unavailable}
  def record(subject, network_id, channel, members, ts)
      when is_integer(network_id) and is_binary(channel) and is_map(members) and is_integer(ts) do
    attrs =
      Subject.put_subject_id(
        %{network_id: network_id, channel: channel, ts: ts, nicks: Map.keys(members)},
        subject
      )

    changeset = Snapshot.changeset(%Snapshot{}, attrs)
    BusyRetry.run(fn -> Repo.insert(changeset) end)
  end
end
