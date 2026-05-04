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

  # L-irc-1: the prefix-less sentinel is a literal `"*"` per the RFC
  # 2812 message-grammar boundary — when no prefix is present the
  # sender is the local connection (server's own perspective on a
  # client-originated line). The sentinel surfaces here in
  # `sender_nick/1`'s `nil` clause and is also accepted by
  # `Grappa.IRC.Identifier.valid_sender?/1` (the inbound-validator
  # boundary). Keep both sites referencing this constant so the magic
  # value lives in ONE place — a future change (e.g. switching to a
  # tagged sentinel like `:anonymous` for type-safety) only edits this
  # constant + its two consumers, not every grep result.
  @anonymous_sender "*"

  @doc """
  The literal sentinel returned by `sender_nick/1` for prefix-less
  lines. Documented at the boundary so callers that need to recognise
  the "no real sender" case can pattern-match against this constant
  rather than re-typing `"*"` everywhere.

  Per `Grappa.IRC.Identifier.valid_sender?/1`, this same `"*"` token
  is also a valid persisted-row sender — the storage layer treats it
  as a closed-set value alongside nicks, host shapes, and bracketed
  meta-sender markers (`<system>` etc.).
  """
  @spec anonymous_sender() :: String.t()
  def anonymous_sender, do: @anonymous_sender

  @doc """
  Returns the sender nickname (user-originated lines), the server name
  (server-originated lines), or the `anonymous_sender/0` sentinel
  (`"*"`) for prefix-less client-originated lines.

  Centralised here so consumers do not pattern-match on the prefix
  tuple shape directly — that internal shape stays an implementation
  detail of this module (architecture review A5). The `"*"` sentinel
  is the closed-set value documented at `anonymous_sender/0`; pattern
  matchers should compare against that constant, not a re-typed
  literal.
  """
  @spec sender_nick(t() | prefix()) :: String.t()
  def sender_nick(%__MODULE__{prefix: prefix}), do: sender_nick(prefix)
  def sender_nick({:nick, nick, _, _}), do: nick
  def sender_nick({:server, server}), do: server
  def sender_nick(nil), do: @anonymous_sender

  @doc """
  Returns the value of an IRCv3 message-tag, or `nil` when the tag is
  absent. Tag-only entries (`@account` with no `=`) yield `true`.

  Centralised accessor so consumers do not poke at the `tags` map
  directly — keeps the storage shape (today: a `%{String.t() => ...}`
  map; tomorrow: maybe a struct with normalized vendor-prefix keys) an
  implementation detail of this module.
  """
  @spec tag(t(), String.t()) :: String.t() | true | nil
  def tag(%__MODULE__{tags: tags}, key) when is_binary(key), do: Map.get(tags, key)

  @doc """
  Returns the value of an IRCv3 message-tag, or `default` when absent.
  Tag-only entries (`@account` with no `=`) yield `true`.
  """
  @spec tag(t(), String.t(), default) :: String.t() | true | default when default: term()
  def tag(%__MODULE__{tags: tags}, key, default) when is_binary(key),
    do: Map.get(tags, key, default)
end
