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
  - `:command` — typed command. Atoms for the closed RFC 2812 / IRCv3
    set (`:privmsg`, `:join`, `:cap`, ...); `{:numeric, 1..999}` for
    server replies (`001`, `376`); `{:unknown, "STRING"}` for vendor
    extensions outside the recognised set. Atomization happens at the
    parser boundary against an explicit allowlist (no atom-table-DoS
    risk — the closed set is bounded).
  - `:params` — middle params + trailing param flattened into one list
    in arrival order. The trailing `:`-prefixed param is the final
    element when present and may contain spaces; middle params do not.

  Per CLAUDE.md "Atoms or `@type t :: literal | literal` — never
  untyped strings for closed sets" — `prefix` uses tagged tuples
  (`:server` / `:nick`) and `command` uses atom enum + tagged numeric
  tuple so pattern matching at the consumer (Session.Server) is
  exhaustive and Dialyzer-checkable.
  """

  @type prefix ::
          {:nick, String.t(), String.t() | nil, String.t() | nil}
          | {:server, String.t()}
          | nil

  @type command ::
          :privmsg
          | :notice
          | :join
          | :part
          | :quit
          | :nick
          | :user
          | :mode
          | :topic
          | :kick
          | :ping
          | :pong
          | :cap
          | :authenticate
          | :error
          | :pass
          | :wallops
          | :invite
          | :who
          | :whois
          | :whowas
          | :kill
          | :oper
          | :away
          | :ison
          | {:numeric, 1..999}
          | {:unknown, String.t()}

  @type tags :: %{optional(String.t()) => String.t() | true}

  @type t :: %__MODULE__{
          tags: tags(),
          prefix: prefix(),
          command: command(),
          params: [String.t()]
        }

  @enforce_keys [:command]
  defstruct tags: %{}, prefix: nil, command: nil, params: []

  @doc """
  Returns the sender nickname (user-originated lines), the server name
  (server-originated lines), or `"*"` for prefix-less client-originated
  lines.

  Centralised here so consumers do not pattern-match on the prefix
  tuple shape directly — that internal shape stays an implementation
  detail of this module (architecture review A5).
  """
  @spec sender_nick(t() | prefix()) :: String.t()
  def sender_nick(%__MODULE__{prefix: prefix}), do: sender_nick(prefix)
  def sender_nick({:nick, nick, _, _}), do: nick
  def sender_nick({:server, server}), do: server
  def sender_nick(nil), do: "*"
end
