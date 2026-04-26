defmodule Grappa.IRC.Parser do
  @moduledoc """
  Single-source IRC line parser. Produces `Grappa.IRC.Message` structs
  for both directions of Phase 6's eventual listener facade — upstream
  `Grappa.IRC.Client` reads (consumed by `Grappa.Session.Server`) and
  downstream `Grappa.IRCv3.Listener` reads from PWA clients.

  ## Grammar (RFC 2812 + IRCv3.1 message-tags)

      line       = [ "@" tags SPACE ] [ ":" prefix SPACE ] command [ params ] [CRLF]
      tags       = tag *( ";" tag )
      tag        = key [ "=" escaped-value ]
      prefix     = servername / ( nickname [ "!" user ] [ "@" host ] )
      command    = 1*letter / 3digit
      params     = *14( SPACE middle ) [ SPACE ":" trailing ]
      middle     = nospcrlfcl *(":" / nospcrlfcl)
      trailing   = *(":" / " " / nospcrlfcl)

  ## Charset boundary (CLAUDE.md "IRC is bytes; the web is UTF-8")

  Input is raw bytes from the socket. The parser converts to UTF-8 at
  entry — UTF-8 first; if that fails (incomplete or invalid sequences)
  the whole line is re-decoded from latin1. Real-world IRC servers
  either talk UTF-8 cleanly or talk latin1 wholesale; mixed encoding
  within a single line is broken regardless. Downstream code
  (`Grappa.Session.Server`, scrollback writes, PubSub broadcasts) only
  ever sees canonical UTF-8.

  ## CTCP framing preserved verbatim

  CTCP delimiters (`\\x01`) inside trailing params are NOT stripped —
  ACTION (`\\x01ACTION ...\\x01`) and other CTCP verbs round-trip
  through the scrollback `body` column intact. CLAUDE.md "CTCP control
  characters are preserved as-is in the scrollback body."

  ## Why `parse_prefix` uses a dot-heuristic

  RFC 2812 prefix grammar is technically ambiguous between `nickname`
  and `servername` for bare tokens with no `!` or `@` (`:server` could
  be either). The conventional resolution — used by every sensible IRC
  parser — is "contains a dot → server, else → nickname." Modern IRC
  servers self-identify with dotted FQDNs (`irc.azzurra.chat`) so this
  heuristic is reliable in practice.

  ## Command atomization (closed-set boundary)

  Commands are normalized at parse time:

    * RFC numerics (`"001"`, `"376"` — three ASCII digits) become
      `{:numeric, 0..999}`.
    * Recognised RFC 2812 / IRCv3 verbs become atoms (`"PRIVMSG"` →
      `:privmsg`). The match is case-insensitive — RFC 2812 §2.3
      defines commands as case-insensitive, even though servers send
      uppercase by convention.
    * Anything else becomes `{:unknown, "UPPERCASED"}` so consumers can
      pattern-match on the tagged shape without atom-table-DoS risk.

  The allowlist is closed (~24 verbs) and lives in this module's
  `@known_commands` attribute; expanding it for a new RFC verb is a
  one-line edit.
  """

  alias Grappa.IRC.Message

  @type parse_error :: :empty | :no_command

  @known_commands %{
    "PRIVMSG" => :privmsg,
    "NOTICE" => :notice,
    "JOIN" => :join,
    "PART" => :part,
    "QUIT" => :quit,
    "NICK" => :nick,
    "USER" => :user,
    "MODE" => :mode,
    "TOPIC" => :topic,
    "KICK" => :kick,
    "PING" => :ping,
    "PONG" => :pong,
    "CAP" => :cap,
    "AUTHENTICATE" => :authenticate,
    "ERROR" => :error,
    "PASS" => :pass,
    "WALLOPS" => :wallops,
    "INVITE" => :invite,
    "WHO" => :who,
    "WHOIS" => :whois,
    "WHOWAS" => :whowas,
    "KILL" => :kill,
    "OPER" => :oper,
    "AWAY" => :away,
    "ISON" => :ison
  }

  @doc """
  Parses one line of IRC into `Grappa.IRC.Message`.

  Input is the raw byte string from the socket WITHOUT a trailing
  newline (the socket runs in `packet: :line` mode which strips `\\n`),
  but trailing `\\r` is tolerated for paranoia.

  Returns `{:ok, %Message{}}` on success or `{:error, reason}` for
  empty / no-command lines. Malformed prefix or oddly-shaped tags do
  NOT cause an error — the parser is liberal in what it accepts and
  produces best-effort output (e.g. an unparseable single-token prefix
  becomes `{:nick, token, nil, nil}`). Downstream consumers ignore
  events whose shape doesn't match a handled command — defensive
  parsing here would just shift the rejection point.
  """
  @spec parse(binary()) :: {:ok, Message.t()} | {:error, parse_error()}
  def parse(raw) when is_binary(raw) do
    line =
      raw
      |> to_utf8()
      |> trim_crlf()
      |> String.trim_leading()

    if line == "", do: {:error, :empty}, else: parse_line(line)
  end

  @spec parse_line(String.t()) :: {:ok, Message.t()} | {:error, parse_error()}
  defp parse_line(line) do
    {tags, after_tags} = take_tags(line)
    {prefix, after_prefix} = take_prefix(after_tags)

    case parse_command_and_params(after_prefix) do
      {:ok, {command, params}} ->
        {:ok,
         %Message{
           tags: tags,
           prefix: prefix,
           command: normalize_command(command),
           params: params
         }}

      {:error, _} = err ->
        err
    end
  end

  @spec normalize_command(String.t()) :: Message.command()
  defp normalize_command(<<a, b, c>>) when a in ?0..?9 and b in ?0..?9 and c in ?0..?9 do
    {:numeric, (a - ?0) * 100 + (b - ?0) * 10 + (c - ?0)}
  end

  defp normalize_command(raw) do
    upper = String.upcase(raw)

    case Map.fetch(@known_commands, upper) do
      {:ok, atom} -> atom
      :error -> {:unknown, upper}
    end
  end

  defp take_tags("@" <> rest) do
    case String.split(rest, " ", parts: 2) do
      [tags_blob, after_tags] -> {parse_tags(tags_blob), String.trim_leading(after_tags)}
      [tags_blob] -> {parse_tags(tags_blob), ""}
    end
  end

  defp take_tags(line), do: {%{}, line}

  defp parse_tags(blob) do
    blob
    |> String.split(";", trim: true)
    |> Map.new(&parse_tag/1)
  end

  defp parse_tag(entry) do
    case String.split(entry, "=", parts: 2) do
      [key, value] -> {key, unescape_tag_value(value)}
      [key] -> {key, true}
    end
  end

  defp unescape_tag_value(value), do: do_unescape(value, <<>>)

  defp do_unescape(<<>>, acc), do: acc
  defp do_unescape(<<"\\:", rest::binary>>, acc), do: do_unescape(rest, <<acc::binary, ?;>>)
  defp do_unescape(<<"\\s", rest::binary>>, acc), do: do_unescape(rest, <<acc::binary, ?\s>>)
  defp do_unescape(<<"\\\\", rest::binary>>, acc), do: do_unescape(rest, <<acc::binary, ?\\>>)
  defp do_unescape(<<"\\r", rest::binary>>, acc), do: do_unescape(rest, <<acc::binary, ?\r>>)
  defp do_unescape(<<"\\n", rest::binary>>, acc), do: do_unescape(rest, <<acc::binary, ?\n>>)

  defp do_unescape(<<"\\", c::utf8, rest::binary>>, acc),
    do: do_unescape(rest, <<acc::binary, c::utf8>>)

  defp do_unescape(<<"\\">>, acc), do: acc

  defp do_unescape(<<c::utf8, rest::binary>>, acc),
    do: do_unescape(rest, <<acc::binary, c::utf8>>)

  defp take_prefix(":" <> rest) do
    case String.split(rest, " ", parts: 2) do
      [prefix_str, after_prefix] -> {parse_prefix(prefix_str), String.trim_leading(after_prefix)}
      [prefix_str] -> {parse_prefix(prefix_str), ""}
    end
  end

  defp take_prefix(line), do: {nil, line}

  defp parse_prefix(raw) do
    cond do
      String.contains?(raw, "!") ->
        [nick, rest] = String.split(raw, "!", parts: 2)

        case String.split(rest, "@", parts: 2) do
          [user, host] -> {:nick, nick, user, host}
          [user] -> {:nick, nick, user, nil}
        end

      String.contains?(raw, "@") ->
        [nick, host] = String.split(raw, "@", parts: 2)
        {:nick, nick, nil, host}

      String.contains?(raw, ".") ->
        {:server, raw}

      true ->
        {:nick, raw, nil, nil}
    end
  end

  defp parse_command_and_params(""), do: {:error, :no_command}

  defp parse_command_and_params(line) do
    case String.split(line, " ", parts: 2) do
      [command] -> {:ok, {command, []}}
      [command, rest] -> {:ok, {command, parse_params(String.trim_leading(rest), [])}}
    end
  end

  defp parse_params("", acc), do: Enum.reverse(acc)
  defp parse_params(":" <> trailing, acc), do: Enum.reverse([trailing | acc])

  defp parse_params(rest, acc) do
    case String.split(rest, " ", parts: 2) do
      [param] -> Enum.reverse([param | acc])
      [param, rest] -> parse_params(String.trim_leading(rest), [param | acc])
    end
  end

  defp trim_crlf(line) do
    line
    |> String.trim_trailing("\n")
    |> String.trim_trailing("\r")
  end

  defp to_utf8(bytes) do
    case :unicode.characters_to_binary(bytes, :utf8, :utf8) do
      result when is_binary(result) -> result
      _ -> latin1_to_utf8(bytes)
    end
  end

  # Latin-1 → UTF-8 is total in practice — every byte is a valid Latin-1
  # codepoint. The Erlang spec is permissive enough that dialyzer can't
  # prove the success-only path, hence the catch-all returning original
  # bytes. The `_` clause is dead at runtime; it pins the return type to
  # `binary()` for the typechecker.
  defp latin1_to_utf8(bytes) do
    case :unicode.characters_to_binary(bytes, :latin1, :utf8) do
      result when is_binary(result) -> result
      _ -> bytes
    end
  end
end
