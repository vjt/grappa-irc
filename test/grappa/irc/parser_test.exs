defmodule Grappa.IRC.ParserTest do
  @moduledoc """
  Unit tests for `Grappa.IRC.Parser`. Pinned at the protocol level —
  every shape the upstream socket might produce gets a named test so a
  regression on (e.g.) tag escaping or CTCP framing surfaces with a
  test name pointing at the rule that broke.

  Property-based round-trip coverage lives in
  `Grappa.IRC.Parser.PropertyTest`.
  """
  use ExUnit.Case, async: true

  alias Grappa.IRC.{Message, Parser}

  describe "parse/1 — basic shapes (RFC 2812)" do
    test "PRIVMSG with nick!user@host prefix and trailing body" do
      assert {:ok,
              %Message{
                tags: %{},
                prefix: {:nick, "vjt", "~vjt", "host"},
                command: :privmsg,
                params: ["#sniffo", "ciao raga"]
              }} = Parser.parse(":vjt!~vjt@host PRIVMSG #sniffo :ciao raga")
    end

    test "server-prefixed numeric reply (376 End of MOTD)" do
      assert {:ok,
              %Message{
                prefix: {:server, "irc.azzurra.chat"},
                command: {:numeric, 376},
                params: ["vjt", "End of MOTD"]
              }} = Parser.parse(":irc.azzurra.chat 376 vjt :End of MOTD")
    end

    test "001 welcome with multi-word trailing" do
      assert {:ok, %Message{command: {:numeric, 1}, params: ["vjt", "Welcome to Azzurra IRC"]}} =
               Parser.parse(":server 001 vjt :Welcome to Azzurra IRC")
    end

    test "PING with no prefix and trailing token" do
      assert {:ok, %Message{prefix: nil, command: :ping, params: ["foo.bar"]}} =
               Parser.parse("PING :foo.bar")
    end

    test "JOIN with bare channel param (no trailing colon)" do
      assert {:ok,
              %Message{
                prefix: {:nick, "vjt", "~vjt", "host"},
                command: :join,
                params: ["#sniffo"]
              }} = Parser.parse(":vjt!~vjt@host JOIN #sniffo")
    end

    test "MODE with multiple middle params and no trailing" do
      assert {:ok,
              %Message{
                command: :mode,
                params: ["#sniffo", "+o", "alice"]
              }} = Parser.parse(":vjt!~vjt@host MODE #sniffo +o alice")
    end

    test "QUIT with trailing reason only (no middle params)" do
      assert {:ok,
              %Message{
                prefix: {:nick, "vjt", "~vjt", "host"},
                command: :quit,
                params: ["Connection reset"]
              }} = Parser.parse(":vjt!~vjt@host QUIT :Connection reset")
    end

    test "CAP LS reply (multi-token middle + trailing capability list)" do
      assert {:ok,
              %Message{
                prefix: {:server, "irc.azzurra.chat"},
                command: :cap,
                params: ["*", "LS", "sasl message-tags server-time"]
              }} =
               Parser.parse(":irc.azzurra.chat CAP * LS :sasl message-tags server-time")
    end

    test "trailing CRLF is stripped" do
      assert {:ok, %Message{command: :ping, params: ["x"]}} = Parser.parse("PING :x\r\n")
    end

    test "trailing LF only (line-mode socket already strips \\n but be defensive)" do
      assert {:ok, %Message{command: :ping, params: ["x"]}} = Parser.parse("PING :x\n")
    end

    test "lowercase command is normalised to atom (RFC 2812 case-insensitivity)" do
      assert {:ok, %Message{command: :privmsg, params: ["#x", "hi"]}} =
               Parser.parse(":a privmsg #x :hi")
    end

    test "unknown vendor command becomes {:unknown, uppercased}" do
      assert {:ok, %Message{command: {:unknown, "FOOBAR"}, params: ["#x"]}} =
               Parser.parse(":a FOOBAR #x")
    end

    test "numeric 000 is parsed as {:numeric, 0}" do
      assert {:ok, %Message{command: {:numeric, 0}, params: []}} = Parser.parse("000")
    end
  end

  describe "parse/1 — prefix variants" do
    test "nick-only prefix (no ! or @): classified as :nick when no dot" do
      assert {:ok, %Message{prefix: {:nick, "alice", nil, nil}, command: :join}} =
               Parser.parse(":alice JOIN #x")
    end

    test "host-only prefix (with dot): classified as :server" do
      assert {:ok, %Message{prefix: {:server, "irc.example.org"}, command: :notice}} =
               Parser.parse(":irc.example.org NOTICE * :hi")
    end

    test "nick!user with no @host: user present, host nil" do
      assert {:ok, %Message{prefix: {:nick, "vjt", "~vjt", nil}, command: :join}} =
               Parser.parse(":vjt!~vjt JOIN #x")
    end

    test "nick@host with no !user: user nil, host present" do
      assert {:ok, %Message{prefix: {:nick, "vjt", nil, "host"}, command: :join}} =
               Parser.parse(":vjt@host JOIN #x")
    end
  end

  describe "parse/1 — IRCv3 message-tags" do
    test "single key=value tag" do
      assert {:ok, %Message{tags: %{"account" => "vjt"}, command: :privmsg}} =
               Parser.parse("@account=vjt :vjt!~vjt@host PRIVMSG #sniffo :hi")
    end

    test "multiple ;-separated tags" do
      assert {:ok,
              %Message{
                tags: %{"time" => "2026-04-25T12:00:00.000Z", "account" => "vjt"},
                command: :privmsg
              }} =
               Parser.parse("@time=2026-04-25T12:00:00.000Z;account=vjt :vjt!~vjt@host PRIVMSG #x :hi")
    end

    test "tag without value (key-only): value is `true`" do
      assert {:ok, %Message{tags: %{"foo" => true}}} = Parser.parse("@foo PING :x")
    end

    test "tag with empty value (key=): value is empty string" do
      assert {:ok, %Message{tags: %{"foo" => ""}}} = Parser.parse("@foo= PING :x")
    end

    test "vendor-prefixed tag name (draft/...) preserved verbatim" do
      assert {:ok, %Message{tags: %{"draft/reply" => "abc123"}}} =
               Parser.parse("@draft/reply=abc123 :a PRIVMSG #x :hi")
    end

    test "tag value escapes are decoded (\\: → ;, \\s → space, \\\\ → \\, \\r → CR, \\n → LF)" do
      assert {:ok, %Message{tags: %{"k" => "a;b c\\d\r\n"}}} =
               Parser.parse("@k=a\\:b\\sc\\\\d\\r\\n PING :x")
    end

    test "tag with no prefix (just tags + command)" do
      assert {:ok, %Message{tags: %{"foo" => "bar"}, prefix: nil, command: :ping}} =
               Parser.parse("@foo=bar PING :x")
    end
  end

  describe "parse/1 — charset boundary (UTF-8 / latin1 fallback)" do
    test "valid UTF-8 trailing param round-trips bytewise" do
      assert {:ok, %Message{params: ["#sniffo", "ciào ragà ✨"]}} =
               Parser.parse(":vjt!~vjt@host PRIVMSG #sniffo :ciào ragà ✨")
    end

    test "latin1-encoded bytes (à == 0xE0) decoded as UTF-8 character" do
      # `à` = U+00E0. In latin1: single byte 0xE0. In UTF-8: 0xC3 0xA0.
      # Some legacy IRC servers/clients emit latin1; the parser must
      # transcode at the boundary so downstream sees UTF-8 only.
      raw = <<":vjt!~vjt@host PRIVMSG #sniffo :ci", 0xE0, "o ragazzi">>
      assert {:ok, %Message{params: ["#sniffo", "ciào ragazzi"]}} = Parser.parse(raw)
    end

    test "lone 0xC3 (incomplete UTF-8 sequence) falls back to latin1" do
      raw = <<":a PRIVMSG #x :", 0xC3>>
      assert {:ok, %Message{params: ["#x", "Ã"]}} = Parser.parse(raw)
    end
  end

  describe "parse/1 — CTCP framing (preserve \\x01 verbatim)" do
    test "ACTION (bare CTCP verb in trailing): \\x01 bytes round-trip into body" do
      raw = ":vjt!~vjt@host PRIVMSG #sniffo :\x01ACTION slaps trout\x01"

      assert {:ok, %Message{params: ["#sniffo", "\x01ACTION slaps trout\x01"]}} =
               Parser.parse(raw)
    end

    test "VERSION CTCP request in NOTICE preserves framing" do
      raw = ":vjt!~vjt@host NOTICE alice :\x01VERSION\x01"

      assert {:ok, %Message{command: :notice, params: ["alice", "\x01VERSION\x01"]}} =
               Parser.parse(raw)
    end
  end

  describe "parse/1 — CR/LF stripping invariant (C6 / S5)" do
    # RFC 2812: "no occurrence of CR or LF is allowed inside an IRC
    # message." The socket's `packet: :line` mode strips the trailing
    # `\n` before delivery, so only embedded `\r` (and theoretical
    # embedded `\n` from a misframed transport) can survive into raw
    # bytes. The parser invariant: produced `params`, `command`, and
    # `prefix` tokens NEVER contain `\r` or `\n` — downstream callers
    # (notably `Session.Server` echoing PING tokens via
    # `Client.send_pong/2`) rely on this so they don't have to
    # re-validate parser output.
    # Stripping (not splitting) merges hostile adjacent commands into
    # a single garbled token — that's intentional. The invariant we
    # need is "tokens never contain `\r` or `\n`" so an echoing caller
    # (`Session.Server` → `Client.send_pong/2`) cannot leak a second
    # CRLF-framed command onto the wire. The fact that the second
    # command's bytes survive concatenated into the first param is a
    # garbled-message UX issue, not a security one.
    test "embedded CR in trailing param: token contains no CR (PING attack)" do
      assert {:ok, %Message{command: :ping, params: [token]}} =
               Parser.parse("PING :tok\rNICK pwn")

      refute String.contains?(token, "\r")
      refute String.contains?(token, "\n")
    end

    test "embedded LF in trailing param: token contains no LF" do
      assert {:ok, %Message{command: :ping, params: [token]}} =
               Parser.parse("PING :tok\nNICK pwn")

      refute String.contains?(token, "\n")
    end

    test "embedded CR in middle param: token contains no CR" do
      assert {:ok, %Message{command: :join, params: [channel]}} =
               Parser.parse("JOIN #chan\rQUIT")

      refute String.contains?(channel, "\r")
    end

    test "embedded CR in PRIVMSG body: body contains no CR (no smuggling)" do
      assert {:ok, %Message{command: :privmsg, params: ["#sniffo", body]}} =
               Parser.parse(":vjt!~vjt@host PRIVMSG #sniffo :ciao\rQUIT :pwn")

      refute String.contains?(body, "\r")
      refute String.contains?(body, "\n")
    end

    test "trailing CR/LF is stripped (existing tolerance preserved)" do
      assert {:ok, %Message{command: :ping, params: ["foo"]}} =
               Parser.parse("PING :foo\r\n")
    end
  end

  describe "parse/1 — error cases" do
    test "empty string rejected" do
      assert {:error, :empty} = Parser.parse("")
    end

    test "whitespace-only rejected (no command)" do
      assert {:error, :empty} = Parser.parse("   ")
    end

    test "lone CRLF rejected" do
      assert {:error, :empty} = Parser.parse("\r\n")
    end

    test "prefix-only with no command rejected" do
      assert {:error, :no_command} = Parser.parse(":vjt!~vjt@host")
    end

    test "tags-only with no command rejected" do
      assert {:error, :no_command} = Parser.parse("@foo=bar")
    end

    test "tags + prefix with no command rejected" do
      assert {:error, :no_command} = Parser.parse("@foo=bar :vjt!~vjt@host")
    end
  end
end
