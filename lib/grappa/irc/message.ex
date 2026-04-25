defmodule Grappa.IRC.Message do
  @moduledoc """
  Parsed IRC line — the canonical in-memory shape produced by
  `Grappa.IRC.Parser.parse/1` and consumed by `Grappa.IRC.Client`
  (re-dispatched to a `Grappa.Session.Server` mailbox).

  RFC 2812 + IRCv3.1 message-tags. Bytes-on-the-wire are normalized to
  UTF-8 by the parser at this boundary (per CLAUDE.md "IRC is bytes;
  the web is UTF-8 — convert at the boundary"). CTCP `\\x01` framing
  inside trailing params is preserved verbatim.

  ## Fields

  - `:tags` — IRCv3 message-tag map. Keys are the raw tag names
    (`"time"`, `"account"`, vendor-prefixed `"draft/foo"`, etc.).
    Values are the unescaped tag value, or `true` for tag-only entries
    (`@account :nick PRIVMSG ...`). Empty map when no `@` block.
  - `:prefix` — origin classifier. `nil` for client-originated lines
    that ride bare. `{:server, "irc.azzurra.chat"}` for server-side
    numerics + notices. `{:nick, nick, user_or_nil, host_or_nil}` for
    user-originated traffic — `user`/`host` are nullable because some
    networks omit one or both fields.
  - `:command` — verb upper-case for letters (`"PRIVMSG"`), or numeric
    string for replies (`"001"`, `"376"`). The parser does NOT atomize
    — too many vendor numerics, atom-table-DoS surface.
  - `:params` — middle params + trailing param flattened into one list
    in arrival order. The trailing `:`-prefixed param is the final
    element when present and may contain spaces; middle params do not.

  Per CLAUDE.md "Atoms or `@type t :: literal | literal` — never
  untyped strings for closed sets" — `prefix` uses tagged tuples
  (`:server` / `:nick`) instead of an unstructured map so pattern
  matching at the consumer (Session.Server) is exhaustive.
  """

  @type prefix ::
          {:nick, String.t(), String.t() | nil, String.t() | nil}
          | {:server, String.t()}
          | nil

  @type tags :: %{optional(String.t()) => String.t() | true}

  @type t :: %__MODULE__{
          tags: tags(),
          prefix: prefix(),
          command: String.t(),
          params: [String.t()]
        }

  defstruct tags: %{}, prefix: nil, command: "", params: []
end
