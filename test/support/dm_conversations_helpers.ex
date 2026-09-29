defmodule Grappa.DmConversationsHelpers do
  @moduledoc """
  Test-only oracle for issue 1365's one invariant: every `messages` row sits
  in the DM conversation its key names, and only DM rows sit in one.

  A row is DIVERGENT when either:

    * its key `COALESCE(dm_with, channel)` is DM-eligible (not `$server`, no
      channel sigil — `Scrollback.dm_eligible?/1`) and its
      `dm_conversation_id` is NULL, or points at a conversation whose folded
      `peer_nick`, subject or network differs from the row's; or
    * its key is NOT DM-eligible and it points at a conversation anyway.

  Written as ONE SQL statement over the tables, independent of the code that
  sets the FK, so it can judge that code. Both the backfill migration test
  and the live write-path tests assert it is zero, and each carries a
  negative control proving it is not zero by construction.
  """
  use Boundary, top_level?: true, deps: [Grappa.Repo]

  alias Grappa.Repo

  @key "COALESCE(m.dm_with, m.channel)"
  @eligible "(#{@key} <> '$server' AND substr(#{@key}, 1, 1) NOT IN ('#', '&', '!', '+'))"

  @doc "Ids of every divergent `messages` row, ascending."
  @spec divergent_message_ids() :: [integer()]
  def divergent_message_ids do
    %{rows: rows} =
      Repo.query!("""
      SELECT m.id
      FROM messages m
      LEFT JOIN dm_conversations c ON c.id = m.dm_conversation_id
      WHERE (#{@eligible} AND (
               c.id IS NULL
               OR lower(c.peer_nick) <> lower(#{@key})
               OR c.user_id IS NOT m.user_id
               OR c.visitor_id IS NOT m.visitor_id
               OR c.network_id <> m.network_id))
         OR (NOT #{@eligible} AND m.dm_conversation_id IS NOT NULL)
      ORDER BY m.id
      """)

    List.flatten(rows)
  end
end
