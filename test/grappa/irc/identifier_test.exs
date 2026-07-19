defmodule Grappa.IRC.IdentifierTest do
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias Grappa.IRC.Identifier

  describe "valid_nick?/1" do
    test "accepts RFC-shape nicks" do
      assert Identifier.valid_nick?("vjt")
      assert Identifier.valid_nick?("alice123")
      assert Identifier.valid_nick?("bob_underscore")
      assert Identifier.valid_nick?("user-with-dash")
      assert Identifier.valid_nick?("[bracket]")
      assert Identifier.valid_nick?("a")
    end

    test "rejects nicks starting with a digit" do
      refute Identifier.valid_nick?("1abc")
    end

    test "rejects nicks starting with a dash (RFC 2812 §2.3.1: dash is tail-only)" do
      # F2 (S29 carryover): pre-fix the leading-`-` first-char class
      # would round-trip `-foo` through Identifier validate but the
      # upstream rejects it (432 ERR_ERRONEUSNICKNAME) and the Session
      # restart-loops. Pin the rule here so it can't drift back.
      refute Identifier.valid_nick?("-foo")
      refute Identifier.valid_nick?("-")
      refute Identifier.valid_nick?("--double")
    end

    property "rejects any nick with a leading dash, regardless of tail" do
      # Total cap is 30 chars (1 leading + 29 trailing); cap `tail` at 29
      # so the property tests the leading-dash rule on otherwise-valid
      # inputs, not the length rule.
      check all(tail <- StreamData.string(:ascii, max_length: 29)) do
        refute Identifier.valid_nick?("-" <> tail)
      end
    end

    property "accepts a one-char nick for every legal first-char" do
      first_chars =
        Enum.concat([?A..?Z, ?a..?z, [?[, ?], ?\\, ?`, ?_, ?^, ?{, ?|, ?}]])

      check all(c <- StreamData.member_of(first_chars)) do
        assert Identifier.valid_nick?(<<c>>)
      end
    end

    test "rejects whitespace" do
      refute Identifier.valid_nick?("with space")
      refute Identifier.valid_nick?(" leading")
      refute Identifier.valid_nick?("trailing ")
    end

    test "rejects empty + nil + non-binary" do
      refute Identifier.valid_nick?("")
      refute Identifier.valid_nick?(nil)
      refute Identifier.valid_nick?(:atom)
    end

    test "rejects nicks longer than 30 chars" do
      refute Identifier.valid_nick?(String.duplicate("a", 31))
      assert Identifier.valid_nick?(String.duplicate("a", 30))
    end
  end

  describe "valid_channel?/1" do
    test "accepts # / & / + / ! prefixed channels" do
      assert Identifier.valid_channel?("#sniffo")
      assert Identifier.valid_channel?("&local")
      assert Identifier.valid_channel?("+modeless")
      assert Identifier.valid_channel?("!safe")
    end

    test "rejects channels without RFC prefix" do
      refute Identifier.valid_channel?("sniffo")
      refute Identifier.valid_channel?("@special")
    end

    test "rejects channels with space, comma, BELL" do
      refute Identifier.valid_channel?("#with space")
      refute Identifier.valid_channel?("#with,comma")
      refute Identifier.valid_channel?("#with\x07bell")
    end

    test "rejects empty / nil / lone prefix" do
      refute Identifier.valid_channel?("")
      refute Identifier.valid_channel?(nil)
      refute Identifier.valid_channel?("#")
    end
  end

  describe "sanitize_ident/1" do
    test "strips a single leading tilde (the identd-verified anti-spoof guard)" do
      # grappa runs no identd; the ircd tilde-prefixes unverified idents.
      # A user-supplied leading `~` must not be presented as identd-verified,
      # so strip it (vjt ruling B: sanitize off, don't reject).
      assert Identifier.sanitize_ident("~foo") == "foo"
      assert Identifier.sanitize_ident("~a") == "a"
    end

    test "strips only ONE leading tilde (residual tildes fail validation)" do
      # A second tilde is left in place so valid_ident?/1 rejects it —
      # stripping-all would silently accept `~~evil` as `evil`.
      assert Identifier.sanitize_ident("~~foo") == "~foo"
      refute Identifier.valid_ident?(Identifier.sanitize_ident("~~foo"))
    end

    test "leaves a tilde-free ident untouched" do
      assert Identifier.sanitize_ident("foo") == "foo"
      assert Identifier.sanitize_ident("a.b-c_1") == "a.b-c_1"
    end

    test "a bare tilde sanitizes to empty (then fails validation)" do
      assert Identifier.sanitize_ident("~") == ""
      refute Identifier.valid_ident?(Identifier.sanitize_ident("~"))
    end

    test "passes non-binary through unchanged (mirrors canonical_nick/1)" do
      assert Identifier.sanitize_ident(nil) == nil
      assert Identifier.sanitize_ident(:atom) == :atom
    end
  end

  describe "valid_ident?/1" do
    test "accepts RFC-user-charset idents up to 10 chars" do
      assert Identifier.valid_ident?("vjt")
      assert Identifier.valid_ident?("a")
      assert Identifier.valid_ident?("user_1")
      assert Identifier.valid_ident?("a.b-c_d")
      assert Identifier.valid_ident?("1digit")
      assert Identifier.valid_ident?(String.duplicate("a", 10))
    end

    test "rejects idents longer than 10 chars (vjt ruling B: USERLEN cap)" do
      refute Identifier.valid_ident?(String.duplicate("a", 11))
    end

    test "rejects a leading tilde (must be sanitized off upstream, not validated in)" do
      refute Identifier.valid_ident?("~foo")
    end

    test "rejects @ and whitespace (would split the USER wire token)" do
      refute Identifier.valid_ident?("foo@bar")
      refute Identifier.valid_ident?("with space")
      refute Identifier.valid_ident?(" leading")
      refute Identifier.valid_ident?("trailing ")
    end

    test "rejects a trailing newline / CR (PCRE `$` anchor footgun)" do
      # `$` in Elixir/PCRE matches BEFORE a trailing `\n`, so a `^...$`
      # regex would ACCEPT `grp\n` — letting a newline-terminated ident
      # reach the wire (CRLF injection). The regex uses `\A...\z` anchors
      # precisely to reject these. (The AuthFSM @line_bound_fields guard is
      # a second line of defense, but the shape validator must reject at
      # the boundary.)
      refute Identifier.valid_ident?("grp\n")
      refute Identifier.valid_ident?("grp\r")
      refute Identifier.valid_ident?("grp\r\n")
      refute Identifier.valid_ident?("\ngrp")
    end

    test "rejects empty / nil / non-binary" do
      refute Identifier.valid_ident?("")
      refute Identifier.valid_ident?(nil)
      refute Identifier.valid_ident?(:atom)
    end

    property "accepts any 1..10-length string over the allowed charset" do
      allowed = Enum.concat([?A..?Z, ?a..?z, ?0..?9, [?., ?_, ?-]])

      check all(chars <- StreamData.list_of(StreamData.member_of(allowed), min_length: 1, max_length: 10)) do
        assert Identifier.valid_ident?(List.to_string(chars))
      end
    end
  end

  describe "canonical_channel/1" do
    test "lowercases sigil-prefixed channel names" do
      assert Identifier.canonical_channel("#Chan") == "#chan"
      assert Identifier.canonical_channel("#CHAN") == "#chan"
      assert Identifier.canonical_channel("#cHaN") == "#chan"
      assert Identifier.canonical_channel("&LocalChan") == "&localchan"
      assert Identifier.canonical_channel("!Safe") == "!safe"
      assert Identifier.canonical_channel("+Modeless") == "+modeless"
    end

    test "passes already-lowercase channels through verbatim" do
      assert Identifier.canonical_channel("#chan") == "#chan"
      assert Identifier.canonical_channel("&local") == "&local"
    end

    test "leaves nicks unchanged (case is meaningful for display)" do
      assert Identifier.canonical_channel("Vjt") == "Vjt"
      assert Identifier.canonical_channel("CristoBOT") == "CristoBOT"
    end

    test "leaves the $server pseudo-channel marker unchanged" do
      assert Identifier.canonical_channel("$server") == "$server"
    end

    test "passes non-binary input through unchanged" do
      assert Identifier.canonical_channel(nil) == nil
      assert Identifier.canonical_channel(:atom) == :atom
    end

    test "is idempotent" do
      assert Identifier.canonical_channel(Identifier.canonical_channel("#Chan")) == "#chan"
    end

    property "lowercases any sigil-prefixed channel-shape input" do
      # Channel body chars: anything but space, comma, BELL, and ASCII
      # uppercase (so the lowercase predicate has something to fold).
      sigils = StreamData.member_of([?#, ?&, ?!, ?+])
      body = StreamData.string([?A..?Z, ?a..?z, ?0..?9, ?-], min_length: 1, max_length: 20)

      check all(sigil <- sigils, name <- body) do
        input = <<sigil>> <> name
        canon = Identifier.canonical_channel(input)
        assert canon == String.downcase(input)
        # Round-trip stability.
        assert Identifier.canonical_channel(canon) == canon
      end
    end

    property "leaves any non-sigil input unchanged" do
      # First char anything that is NOT a channel sigil.
      first = StreamData.filter(StreamData.integer(?A..?z), &(&1 not in [?#, ?&, ?!, ?+]))
      tail = StreamData.string(:ascii, max_length: 15)

      check all(c <- first, t <- tail) do
        input = <<c>> <> t
        assert Identifier.canonical_channel(input) == input
      end
    end
  end

  describe "canonical_nick/1 (rfc1459 casemapping — GH #121)" do
    test "ASCII-downcases A-Z" do
      assert Identifier.canonical_nick("Mezmerize") == "mezmerize"
      assert Identifier.canonical_nick("MEZMERIZE") == "mezmerize"
      assert Identifier.canonical_nick("mezmerize") == "mezmerize"
    end

    test "folds rfc1459 bracket chars [ ] \\ ~ -> { } | ^" do
      # bahamut (azzurra) runs rfc1459 casemapping: besides A-Z it folds
      # the four 'national' chars. Two nicks differing only by these are
      # the SAME nick to the ircd.
      assert Identifier.canonical_nick("nick[1]") == "nick{1}"
      assert Identifier.canonical_nick("a\\b") == "a|b"
      assert Identifier.canonical_nick("tilde~") == "tilde^"
      assert Identifier.canonical_nick("Foo[Bar]") == "foo{bar}"
    end

    test "does NOT touch the fold targets { } | ^ (collision-free)" do
      assert Identifier.canonical_nick("nick{1}") == "nick{1}"
      assert Identifier.canonical_nick("a|b") == "a|b"
      assert Identifier.canonical_nick("caret^") == "caret^"
    end

    test "is ASCII-only — leaves UTF-8 multibyte untouched (rfc1459 is byte-level)" do
      # Unlike String.downcase/1, rfc1459 does NOT fold non-ASCII; the
      # SQLite lower() backfill (ASCII-only) must match this exactly.
      assert Identifier.canonical_nick("Ä") == "Ä"
      assert Identifier.canonical_nick("café") == "café"
      assert Identifier.canonical_nick("Über") == "Über"
    end

    test "passes non-binary through (mirror canonical_channel/1)" do
      assert Identifier.canonical_nick(nil) == nil
      assert Identifier.canonical_nick(:atom) == :atom
    end

    test "is idempotent" do
      assert Identifier.canonical_nick(Identifier.canonical_nick("Foo[Bar]")) == "foo{bar}"
    end

    property "matches ASCII-downcase + bracket-fold for any ASCII nick, and is idempotent" do
      bytes = StreamData.list_of(StreamData.integer(?!..?~), min_length: 1, max_length: 20)

      check all(cs <- bytes) do
        input = :binary.list_to_bin(cs)
        canon = Identifier.canonical_nick(input)
        assert Identifier.canonical_nick(canon) == canon

        expected =
          input
          |> String.downcase()
          |> String.replace("[", "{")
          |> String.replace("]", "}")
          |> String.replace("\\", "|")
          |> String.replace("~", "^")

        assert canon == expected
      end
    end
  end

  describe "valid_network_slug?/1" do
    test "accepts lowercase alphanum + dash + underscore" do
      assert Identifier.valid_network_slug?("azzurra")
      assert Identifier.valid_network_slug?("net_1")
      assert Identifier.valid_network_slug?("foo-bar")
      assert Identifier.valid_network_slug?("a")
    end

    test "rejects uppercase" do
      refute Identifier.valid_network_slug?("Azzurra")
    end

    test "rejects path separators (would corrupt PubSub topics)" do
      refute Identifier.valid_network_slug?("foo/bar")
    end

    test "rejects whitespace + special chars" do
      refute Identifier.valid_network_slug?("foo bar")
      refute Identifier.valid_network_slug?("foo:bar")
      refute Identifier.valid_network_slug?("foo.bar")
    end

    test "rejects empty / nil" do
      refute Identifier.valid_network_slug?("")
      refute Identifier.valid_network_slug?(nil)
    end

    test "rejects > 32 chars" do
      refute Identifier.valid_network_slug?(String.duplicate("a", 33))
      assert Identifier.valid_network_slug?(String.duplicate("a", 32))
    end
  end

  describe "valid_host?/1" do
    test "accepts hostnames + IPs" do
      assert Identifier.valid_host?("irc.azzurra.chat")
      assert Identifier.valid_host?("192.168.1.1")
      assert Identifier.valid_host?("[::1]")
      assert Identifier.valid_host?("localhost")
    end

    test "rejects whitespace + control chars" do
      refute Identifier.valid_host?("with space")
      refute Identifier.valid_host?("foo\nbar")
      refute Identifier.valid_host?("foo\x00bar")
    end

    test "rejects empty / nil" do
      refute Identifier.valid_host?("")
      refute Identifier.valid_host?(nil)
    end
  end

  describe "valid_sender?/1" do
    test "accepts nicks" do
      assert Identifier.valid_sender?("vjt")
    end

    test "accepts server names (host shape)" do
      assert Identifier.valid_sender?("irc.azzurra.chat")
    end

    test "accepts the * prefix-less marker" do
      assert Identifier.valid_sender?("*")
    end

    test "accepts <bracketed> meta-sender markers (REST-originated etc.)" do
      assert Identifier.valid_sender?("<local>")
      assert Identifier.valid_sender?("<system>")
    end

    test "rejects empty / nil / whitespace" do
      refute Identifier.valid_sender?("")
      refute Identifier.valid_sender?(nil)
      refute Identifier.valid_sender?("with space")
    end
  end

  # UX-4 bucket G — IRC services-sender classifier. Closed allowlist
  # shared by Session.Server's outbound `service_target?` (PRIVMSG to
  # NickServ: wire-only, no scrollback) and EventRouter's inbound
  # routing (PRIVMSG / NOTICE from NickServ → `$server` window). The
  # allowlist intentionally rejects ops nicks like `Conserv` / `Reserv`
  # — bucket H/S4 closed the same misclassification class for outbound.
  describe "services_sender?/1" do
    test "accepts the eight well-known services nicks (case-insensitive)" do
      for nick <- ~w(NickServ ChanServ MemoServ OperServ BotServ HostServ HelpServ RootServ) do
        assert Identifier.services_sender?(nick), "expected #{nick} to classify as services"
        assert Identifier.services_sender?(String.downcase(nick))
        assert Identifier.services_sender?(String.upcase(nick))
      end
    end

    test "rejects channel-sigil targets without inspecting the allowlist" do
      refute Identifier.services_sender?("#nickserv")
      refute Identifier.services_sender?("&chanserv")
      refute Identifier.services_sender?("+memoserv")
      refute Identifier.services_sender?("!operserv")
      # The classifier is sigil-aware even when the suffix matches —
      # ops sometimes set up `#dataserv` channels and PRIVMSGs to them
      # must NOT trigger the no-persist credential branch.
      refute Identifier.services_sender?("#dataserv")
    end

    test "rejects ops nicks that happen to end in 'serv' (bucket H regression guard)" do
      refute Identifier.services_sender?("Conserv")
      refute Identifier.services_sender?("Dataserv")
      refute Identifier.services_sender?("Reserv")
      refute Identifier.services_sender?("bobserv")
      refute Identifier.services_sender?("conserve")
    end

    test "rejects non-binary / empty input" do
      refute Identifier.services_sender?(nil)
      refute Identifier.services_sender?(:nickserv)
      refute Identifier.services_sender?("")
      refute Identifier.services_sender?(123)
    end

    property "any non-allowlist binary returns false" do
      # Generate binaries that explicitly do NOT match the allowlist
      # (case-insensitive). Property: services_sender?/1 is false for
      # every such input.
      allowlist =
        MapSet.new(~w(nickserv chanserv memoserv operserv botserv hostserv helpserv))

      check all(s <- StreamData.string(:ascii, min_length: 1, max_length: 20)) do
        if String.downcase(s) in allowlist do
          assert Identifier.services_sender?(s)
        else
          # Channel-sigil prefixes always false; non-allowlist always false.
          refute Identifier.services_sender?(s)
        end
      end
    end
  end

  describe "safe_oper_token?/1 (#20 bundle)" do
    test "accepts non-empty single tokens with no whitespace or control bytes" do
      for s <- ~w(vjt admin-op s3cret hunter2 op_with_underscore) do
        assert Identifier.safe_oper_token?(s), "expected #{s} to pass"
      end
    end

    test "rejects empty string" do
      refute Identifier.safe_oper_token?("")
    end

    test "rejects strings containing space or tab" do
      refute Identifier.safe_oper_token?("vjt extra")
      refute Identifier.safe_oper_token?("admin\tname")
      refute Identifier.safe_oper_token?(" leading")
      refute Identifier.safe_oper_token?("trailing ")
    end

    test "rejects strings containing CR/LF/NUL (line-token superset)" do
      refute Identifier.safe_oper_token?("evil\r\nKILL")
      refute Identifier.safe_oper_token?("evil\nfoo")
      refute Identifier.safe_oper_token?("evil\rfoo")
      refute Identifier.safe_oper_token?("evil\x00foo")
    end

    test "rejects non-binary input" do
      refute Identifier.safe_oper_token?(nil)
      refute Identifier.safe_oper_token?(:atom)
      refute Identifier.safe_oper_token?(42)
    end
  end

  describe "member_prefix/1 (#25 grade-snapshot helper)" do
    test "returns the highest-precedence sigil (@ > % > +)" do
      assert Identifier.member_prefix(["@"]) == "@"
      assert Identifier.member_prefix(["%"]) == "%"
      assert Identifier.member_prefix(["+"]) == "+"
      assert Identifier.member_prefix(["+", "@"]) == "@"
      assert Identifier.member_prefix(["+", "%"]) == "%"
    end

    test "returns nil for a plain member (empty list)" do
      assert Identifier.member_prefix([]) == nil
    end

    test "returns nil for non-list input" do
      assert Identifier.member_prefix(nil) == nil
      assert Identifier.member_prefix("@") == nil
    end
  end

  describe "nick_fold_sql/1 — fold-drift pin (review 2026-07-19)" do
    # The rfc1459 fold SQL lives in three places that MUST stay
    # byte-identical or SQLite silently stops using the folded
    # expression indexes (dedup then quietly breaks): the
    # `nick_fold/1` query fragment, `nick_fold_sql/1` (used by
    # Notify's conflict_target), and each folded-index migration's
    # self-contained copy. This test pins them to one canonical
    # string; a future edit to any site fails loudly here.
    @canonical "replace(replace(replace(replace(lower(COL), '[', '{'), ']', '}'), '\\', '|'), '~', '^')"

    test "nick_fold_sql/1 renders the canonical fold" do
      assert Identifier.nick_fold_sql("COL") == @canonical
      assert Identifier.nick_fold_sql("nick") == String.replace(@canonical, "COL", "nick")
    end

    test "every folded-index migration embeds the canonical fold verbatim" do
      # Migration .exs SOURCE escapes the backslash (`'\\'`), so the
      # source-side pattern doubles it before matching raw file text.
      source_side = fn col ->
        @canonical |> String.replace("COL", col) |> String.replace("\\", "\\\\")
      end

      candidates = [source_side.("\#{col}"), source_side.("target_nick"), source_side.("nick")]

      migrations =
        Path.wildcard("priv/repo/migrations/*.exs")
        |> Enum.filter(&(File.read!(&1) =~ "replace(replace(replace(replace(lower("))

      assert migrations != [], "no folded-index migrations found — glob broken?"

      for path <- migrations do
        source = File.read!(path)

        assert Enum.any?(candidates, &String.contains?(source, &1)),
               "#{path} embeds a fold expression that drifted from Identifier.nick_fold_sql/1"
      end
    end
  end
end
