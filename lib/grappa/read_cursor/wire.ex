defmodule Grappa.ReadCursor.Wire do
  @moduledoc """
  Wire-shape builder for `Grappa.ReadCursor` PubSub broadcasts.

  ## Why this module exists (no-silent-drops B6.9a HIGH-25)

  Every other broadcaster in the codebase routes its payload through a
  context-owned `*.Wire` module — `Grappa.Scrollback.Wire`,
  `Grappa.QueryWindows.Wire`, `Grappa.Networks.Wire`,
  `Grappa.Cic.Wire`, `Grappa.Session.Wire`. `Grappa.ReadCursor` was the
  lone exception, building its `read_cursor_set` payload inline at the
  broadcast site (`broadcast_set/4`).

  Extracting the payload into a typed Wire fn:

    * Pre-empts the Phase 6 IRCv3 listener facade (`+draft/read-marker`
      MARKREAD lines) — the listener side will share the same wire
      shape and a single Wire module makes that an `import` away
      instead of duplicating the literal map.
    * Adds `@type` documentation for the payload so cic narrowers
      (`narrowReadCursorSet` in `userTopic.ts`) can mirror the shape
      verbatim instead of pattern-matching against the comment block.
    * Encodes the CLAUDE.md "single source of truth" pattern uniformly
      so adding a new ReadCursor event later inherits the convention
      automatically.

  ## Wire shape

      %{kind: "read_cursor_set", last_read_message_id: <integer>}

  Both fields are required. `kind` is a string literal so the cic
  dispatcher's `narrowReadCursorSet` lookup is a single `===`
  comparison.
  """

  @typedoc """
  PubSub payload broadcast on the per-channel topic
  (`grappa:user:{user_name}/network:{slug}/channel:{name}`) when the
  operator's read cursor is updated. Cic mirrors via
  `lib/userTopic.ts`'s `narrowReadCursorSet`.
  """
  @type read_cursor_set :: %{
          kind: String.t(),
          last_read_message_id: integer()
        }

  @doc """
  Builds the `read_cursor_set` payload for a given `last_read_message_id`.

  Always returns a plain map (not a struct) per CLAUDE.md "PubSub
  broadcast + Channel push payloads MUST be JSON-encodable" and the
  no-silent-drops B6.2 struct guard at `Grappa.PubSub.broadcast_event/2`.
  """
  @spec read_cursor_set(integer()) :: read_cursor_set()
  def read_cursor_set(last_read_message_id) when is_integer(last_read_message_id) do
    %{
      kind: "read_cursor_set",
      last_read_message_id: last_read_message_id
    }
  end
end
