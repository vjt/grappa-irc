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

  # #676 — the 433 collision-fallback candidate builder. The suffix is the
  # part that MUST survive: a builder that let the cap eat it would hand the
  # ircd back the very nick it just rejected, and the retry ladder would spin
  # to exhaustion against a nick it can never win.
  describe "collision_fallback/3" do
    test "appends the suffix when the cap leaves room" do
      assert Identifier.collision_fallback("vjt", "_", 30) == "vjt_"
    end

    test "trims the BASE (never the suffix) to fit the cap" do
      base = String.duplicate("a", 30)

      assert Identifier.collision_fallback(base, "_", 30) ==
               String.duplicate("a", 29) <> "_"
    end

    test "honours a cap below our own nick ceiling (a short upstream NICKLEN)" do
      assert Identifier.collision_fallback("abcdefghij", "x9", 9) == "abcdefgx9"
    end

    # Deliberately PARTIAL. A cap that cannot hold the suffix has no correct
    # answer — trimming the suffix to fit would re-send the rejected nick —
    # so the guard refuses instead of inventing one. Callers are responsible
    # for a sane cap; `AuthFSM` floors its inferred one for exactly this.
    test "refuses a cap too small to hold the suffix" do
      assert_raise FunctionClauseError, fn ->
        Identifier.collision_fallback("vjt", "abc", 3)
      end
    end

    test "the result is always a valid nick and never exceeds the cap" do
      check all(
              base <- string(?a..?z, min_length: 1, max_length: 30),
              suffix <- string(?a..?z, min_length: 1, max_length: 3),
              cap <- integer(4..30)
            ) do
        out = Identifier.collision_fallback(base, suffix, cap)

        assert Identifier.valid_nick?(out)
        assert String.length(out) <= cap
        assert String.ends_with?(out, suffix)
      end
    end
  end

  describe "random_nick_suffix/0" do
    test "produces a tail-charset suffix that keeps a valid base valid" do
      for _ <- 1..50 do
        suffix = Identifier.random_nick_suffix()

        assert String.match?(suffix, ~r/^[a-z0-9]+$/),
               "expected a nick-tail-safe suffix, got #{inspect(suffix)}"

        assert Identifier.valid_nick?("vjt" <> suffix)
      end
    end

    test "is actually random (50 draws are not one repeated value)" do
      draws = for _ <- 1..50, into: MapSet.new(), do: Identifier.random_nick_suffix()
      assert MapSet.size(draws) > 1
    end
  end

  describe "max_nick_length/0" do
    test "matches the length valid_nick?/1 enforces" do
      cap = Identifier.max_nick_length()

      assert Identifier.valid_nick?(String.duplicate("a", cap))
      refute Identifier.valid_nick?(String.duplicate("a", cap + 1))
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

    test "passes non-binary through unchanged (mirrors canonical_target/1)" do
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

  describe "canonical_target/1 (the single ASCII identifier fold — #121/#364/#525/#537)" do
    test "ASCII-downcases A-Z in channels and nicks alike" do
      assert Identifier.canonical_target("#Chan") == "#chan"
      assert Identifier.canonical_target("#CHAN") == "#chan"
      assert Identifier.canonical_target("&LocalChan") == "&localchan"
      assert Identifier.canonical_target("!Safe") == "!safe"
      assert Identifier.canonical_target("+Modeless") == "+modeless"
      assert Identifier.canonical_target("Mezmerize") == "mezmerize"
      assert Identifier.canonical_target("MEZMERIZE") == "mezmerize"
    end

    test "a channel sigil is fold-invariant — sigil <> fold(body)" do
      # #364: channels and nicks fold through ONE primitive. Sigils
      # (# & ! +) sit outside A-Z, so folding the whole channel equals
      # sigil <> fold(body) — the same fold a bare nick gets.
      for body <- ["Foo[Bar]", "CHAN", "a\\b", "tilde~", "café", "MiXeD{ok}"] do
        assert Identifier.canonical_target("#" <> body) == "#" <> Identifier.canonical_target(body)
      end
    end

    test "does NOT fold bracket chars [ ] \\ ~ in either shape (bahamut is CASEMAPPING=ascii — #525)" do
      # #525: Azzurra advertises AND implements CASEMAPPING=ascii, so
      # `#chan[1]`/`#chan{1}` and `foo[1]`/`foo{1}` are DISTINCT to the ircd
      # — only A-Z folds. Reverses the #364 over-fold that merged the pairs.
      assert Identifier.canonical_target("#chan[1]") == "#chan[1]"
      assert Identifier.canonical_target("#a\\b") == "#a\\b"
      assert Identifier.canonical_target("&tilde~") == "&tilde~"
      assert Identifier.canonical_target("#Foo[Bar]") == "#foo[bar]"
      assert Identifier.canonical_target("nick[1]") == "nick[1]"
      assert Identifier.canonical_target("Foo[Bar]") == "foo[bar]"
    end

    test "does NOT touch the fold targets { } | ^ (collision-free)" do
      assert Identifier.canonical_target("#chan{1}") == "#chan{1}"
      assert Identifier.canonical_target("#a|b") == "#a|b"
      assert Identifier.canonical_target("&caret^") == "&caret^"
      assert Identifier.canonical_target("nick{1}") == "nick{1}"
    end

    test "is ASCII-only — leaves UTF-8 multibyte untouched (the fold is byte-level)" do
      # The old Unicode String.downcase/1 folded É->é so `#CAFÉ`/`#café`
      # merged — WRONG for bahamut, whose ASCII casemapping leaves both
      # distinct. The byte-level fold leaves the multibyte É (>= 0x80)
      # untouched, matching the ASCII-only SQLite lower() backfill.
      assert Identifier.canonical_target("#café") == "#café"
      assert Identifier.canonical_target("#CAFÉ") == "#cafÉ"
      refute Identifier.canonical_target("#CAFÉ") == Identifier.canonical_target("#café")
      assert Identifier.canonical_target("café") == "café"
      assert Identifier.canonical_target("Über") == "Über"
    end

    test "leaves the $server pseudo-channel marker unchanged (fold is a no-op)" do
      assert Identifier.canonical_target("$server") == "$server"
    end

    test "passes already-canonical identifiers through verbatim" do
      assert Identifier.canonical_target("#chan") == "#chan"
      assert Identifier.canonical_target("&local") == "&local"
      assert Identifier.canonical_target("mezmerize") == "mezmerize"
    end

    test "passes non-binary input through unchanged" do
      assert Identifier.canonical_target(nil) == nil
      assert Identifier.canonical_target(:atom) == :atom
    end

    test "is idempotent for both shapes" do
      assert Identifier.canonical_target(Identifier.canonical_target("#Chan[1]")) == "#chan[1]"
      assert Identifier.canonical_target(Identifier.canonical_target("Foo[Bar]")) == "foo[bar]"
    end

    property "folds A-Z only (matches ASCII downcase) for any identifier, and is idempotent" do
      # First byte spans channel sigils AND ordinary nick bytes, so both
      # shapes route through the one fold. Body bytes include the bracket
      # chars so the non-fold of `[ ] \\ ~` is exercised.
      first = StreamData.integer(?!..?~)
      tail = StreamData.list_of(StreamData.integer(?!..?~), max_length: 20)

      check all(f <- first, cs <- tail) do
        input = <<f>> <> :binary.list_to_bin(cs)
        canon = Identifier.canonical_target(input)

        # ASCII fold = downcase A-Z only. The generator is ASCII-only, so
        # String.downcase/1 (Unicode-aware) coincides with the byte-level
        # fold here — brackets `[ ] \\ ~` are left untouched.
        assert canon == String.downcase(input)
        # Round-trip stability.
        assert Identifier.canonical_target(canon) == canon
      end
    end
  end

  describe "canonical_target/2 (network-aware KEY fold — #537)" do
    test "composes normalize_casemapping/2 then the ASCII canonical_target/1" do
      # The single network-aware KEY fold every INGRESS routes through:
      # normalize the national chars for the network, then ASCII-fold. It
      # equals the explicit two-step pipe.
      for {input, cm} <- [
            {"#Foo[1]", :rfc1459},
            {"#Foo[1]", :ascii},
            {"Nick[1]", :rfc1459_strict},
            {"#CHAN", :rfc1459}
          ] do
        assert Identifier.canonical_target(input, cm) ==
                 input |> Identifier.normalize_casemapping(cm) |> Identifier.canonical_target()
      end
    end

    test "on :ascii it is byte-identical to canonical_target/1 (all of prod)" do
      # Azzurra is CASEMAPPING=ascii: the network-aware fold degenerates to
      # the plain ASCII fold, so every ASCII network behaves exactly as pre-#537.
      for input <- ["#Chan", "#chan[1]", "NickTemp", "$server", "#café"] do
        assert Identifier.canonical_target(input, :ascii) == Identifier.canonical_target(input)
      end
    end

    test "two rfc1459 channel spellings converge to ONE key" do
      assert Identifier.canonical_target("#Foo[1]", :rfc1459) ==
               Identifier.canonical_target("#Foo{1}", :rfc1459)

      assert Identifier.canonical_target("#Foo[1]", :rfc1459) == "#foo{1}"
    end

    test "the SAME two spellings stay DISTINCT on :ascii (pins #525)" do
      refute Identifier.canonical_target("#Foo[1]", :ascii) ==
               Identifier.canonical_target("#Foo{1}", :ascii)
    end

    test "passes non-binary through for every casemapping" do
      for cm <- [:ascii, :rfc1459, :rfc1459_strict] do
        assert Identifier.canonical_target(nil, cm) == nil
        assert Identifier.canonical_target(:atom, cm) == :atom
      end
    end
  end

  describe "normalize_casemapping/2 (per-network national-char ingress fold — #537)" do
    test ":ascii is identity — the national chars are meaningful distinct bytes" do
      # bahamut/Azzurra is CASEMAPPING=ascii: `[ ] \\ ~` are ordinary
      # distinct bytes, never folded onto `{ } | ^`. normalize is a no-op;
      # the downstream canonical_target/1 does the A-Z fold. This is the
      # #525 posture — keeping `#foo[1]`/`#foo{1}` DISTINCT.
      for s <- ["#Chan[1]", "foo{1}", "a\\b", "tilde~", "caret^", "#CAFÉ"] do
        assert Identifier.normalize_casemapping(s, :ascii) == s
      end
    end

    test ":rfc1459 folds the national quartet [ ] \\ ~ -> { } | ^" do
      # RFC 2812 §2.2: {}|^ are the lowercase equivalents of []\~. solanum/
      # Libera advertise CASEMAPPING=rfc1459, so `#foo[1]` and `#foo{1}` are
      # ONE channel to the ircd; the ingress normaliser maps the national
      # chars onto their folded representative so the ASCII fold downstream
      # converges them.
      assert Identifier.normalize_casemapping("[", :rfc1459) == "{"
      assert Identifier.normalize_casemapping("]", :rfc1459) == "}"
      assert Identifier.normalize_casemapping("\\", :rfc1459) == "|"
      assert Identifier.normalize_casemapping("~", :rfc1459) == "^"
      assert Identifier.normalize_casemapping("#foo[1]\\~", :rfc1459) == "#foo{1}|^"
    end

    test ":rfc1459 leaves A-Z to the downstream ASCII fold (separation of concerns)" do
      # normalize handles ONLY the national chars; the A-Z fold is
      # canonical_target/1's job. Keeping them split lets the SQL twin
      # (plain lower()) stay byte-pinned to the A-Z fold, per the vjt ruling.
      assert Identifier.normalize_casemapping("Foo", :rfc1459) == "Foo"
      assert Identifier.normalize_casemapping("#CHAN", :rfc1459) == "#CHAN"
    end

    test ":rfc1459 leaves the fold TARGETS { } | ^ untouched (already lowercase)" do
      # {}|^ are the lowercase forms — the ircd never folds them further, so
      # `#foo~` and `#foo^` converge onto `#foo^` (idempotent under re-fold).
      assert Identifier.normalize_casemapping("{}|^", :rfc1459) == "{}|^"
    end

    test ":rfc1459_strict folds [ ] \\ but NOT ~ (RFC 1459 predates the tilde rule)" do
      assert Identifier.normalize_casemapping("[", :rfc1459_strict) == "{"
      assert Identifier.normalize_casemapping("]", :rfc1459_strict) == "}"
      assert Identifier.normalize_casemapping("\\", :rfc1459_strict) == "|"
      # tilde stays a tilde under strict — the strict fold omits it.
      assert Identifier.normalize_casemapping("~", :rfc1459_strict) == "~"
      assert Identifier.normalize_casemapping("#foo[1]~", :rfc1459_strict) == "#foo{1}~"
    end

    test "is byte-level — UTF-8 multibyte passes through every casemapping" do
      # `[ ] \\ ~` are all < 0x80 and never appear as UTF-8 continuation
      # bytes, so multibyte sequences are untouched (mirrors fold_ascii).
      for cm <- [:ascii, :rfc1459, :rfc1459_strict] do
        assert Identifier.normalize_casemapping("café", cm) == "café"
        assert Identifier.normalize_casemapping("Ä", cm) == "Ä"
      end
    end

    test "combined with canonical_target/1, two rfc1459 spellings converge to ONE key" do
      # The whole point of axis 2: on an rfc1459 network `#Foo[1]` and
      # `#Foo{1}` are ONE channel. normalize_casemapping maps the national
      # chars, canonical_target folds A-Z, and both spellings land on the
      # same storage/lookup key.
      key = fn s ->
        s |> Identifier.normalize_casemapping(:rfc1459) |> Identifier.canonical_target()
      end

      assert key.("#Foo[1]") == key.("#Foo{1}")
      assert key.("#Foo[1]") == "#foo{1}"
      # nick-shaped too — rfc1459 folds nicks and channels identically.
      assert key.("Nick[1]") == key.("Nick{1}")
    end

    test "on :ascii the same two spellings stay DISTINCT (pins #525)" do
      key = fn s ->
        s |> Identifier.normalize_casemapping(:ascii) |> Identifier.canonical_target()
      end

      refute key.("#Foo[1]") == key.("#Foo{1}")
      assert key.("#Foo[1]") == "#foo[1]"
    end

    test "passes non-binary through for every casemapping" do
      for cm <- [:ascii, :rfc1459, :rfc1459_strict] do
        assert Identifier.normalize_casemapping(nil, cm) == nil
        assert Identifier.normalize_casemapping(:atom, cm) == :atom
      end
    end

    property ":rfc1459 maps exactly the national quartet, is idempotent, and touches no other byte" do
      bytes = StreamData.list_of(StreamData.integer(?!..?~), min_length: 1, max_length: 20)

      check all(cs <- bytes) do
        input = :binary.list_to_bin(cs)
        out = Identifier.normalize_casemapping(input, :rfc1459)

        # Independent oracle: map the four national chars, leave the rest.
        expected =
          for <<c <- input>>, into: "" do
            case c do
              ?[ -> "{"
              ?] -> "}"
              ?\\ -> "|"
              ?~ -> "^"
              _ -> <<c>>
            end
          end

        assert out == expected
        # Idempotent: the targets {}|^ are never in the source set.
        assert Identifier.normalize_casemapping(out, :rfc1459) == out
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
    test "accepts the eleven well-known services nicks (case-insensitive)" do
      for nick <-
            ~w(NickServ ChanServ MemoServ OperServ BotServ HostServ HelpServ RootServ SeenServ StatServ DebugServ) do
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
      # Mirrors the production `@services` allowlist exactly — keep in
      # lockstep with `Grappa.IRC.Identifier` (and the cic-side twin in
      # `cicchetto/src/lib/servicesSender.ts`). A divergence here makes
      # the property vacuously wrong for a generated allowlist member.
      allowlist =
        MapSet.new(
          ~w(nickserv chanserv memoserv operserv botserv hostserv helpserv rootserv seenserv statserv debugserv)
        )

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

  describe "valid_mode_letter?/1 (#279 mode-token boundary class)" do
    test "accepts every single ASCII letter, both cases" do
      for c <- ?a..?z, do: assert(Identifier.valid_mode_letter?(<<c>>))
      for c <- ?A..?Z, do: assert(Identifier.valid_mode_letter?(<<c>>))
    end

    test "rejects the punctuation/space/control bytes a fuzzed mode param carries" do
      for s <- [" ", "!", "\"", "$", "'", "(", ")", ",", "~", "\x01", "\x7f"] do
        refute Identifier.valid_mode_letter?(s), "expected #{inspect(s)} to be rejected"
      end
    end

    test "rejects digits — no ircd registers a numeric mode char" do
      for s <- ~w(0 1 9), do: refute(Identifier.valid_mode_letter?(s))
    end

    test "rejects the signs themselves (a sign is not a mode letter)" do
      refute Identifier.valid_mode_letter?("+")
      refute Identifier.valid_mode_letter?("-")
    end

    test "rejects multi-byte and non-ASCII input (one letter means one byte)" do
      refute Identifier.valid_mode_letter?("iw")
      refute Identifier.valid_mode_letter?("")
      refute Identifier.valid_mode_letter?("à")
      refute Identifier.valid_mode_letter?("é")
    end

    test "rejects non-binary input" do
      refute Identifier.valid_mode_letter?(nil)
      refute Identifier.valid_mode_letter?(:i)
      refute Identifier.valid_mode_letter?(?i)
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

  describe "nick_fold_sql/1 — ASCII fold pin (#525)" do
    # #525 narrowed the server-wide fold from rfc1459 (A-Z + the four
    # bracket chars `[ ] \\ ~` → `{ } | ^`) to plain ASCII (A-Z only),
    # because Azzurra (bahamut) is CASEMAPPING=ascii. The fold SQL now
    # lives in two runtime sources (`nick_fold/1` fragment,
    # `nick_fold_sql/1`) plus the live folded-index migrations, which MUST
    # stay byte-identical or SQLite silently stops using the expression
    # indexes (the on-conflict target then quietly breaks). This block
    # pins them to one canonical string AND guards against a future
    # reintroduction of the rfc1459 fold.
    @canonical "lower(COL)"

    # The #525 re-fold migration — recreates every live folded index with
    # the ASCII `lower()` expression. Pinned by name so its up-path index
    # literals stay tied to nick_fold_sql/1.
    @refold_migration "priv/repo/migrations/20260729120000_refold_identifiers_ascii.exs"

    # Pre-#525 migrations legitimately embed the rfc1459 four-replace fold
    # (correct when written; #525 supersedes their LIVE indexes). The
    # re-fold migration's own down/0 restores the rfc1459 indexes as its
    # documented inverse, so it is allow-listed too. Anything NEWER than
    # the re-fold must NOT carry the rfc1459 literal.
    @rfc1459_marker "replace(replace(replace(replace(lower("

    test "nick_fold_sql/1 renders the canonical ASCII fold" do
      assert Identifier.nick_fold_sql("COL") == @canonical
      assert Identifier.nick_fold_sql("nick") == "lower(nick)"
      assert Identifier.nick_fold_sql("target_nick") == "lower(target_nick)"

      # #393 — the DM-peer covering index folds the COALESCE window key
      # `COALESCE(dm_with, channel)` (the SAME expression `list_archive/3`'s
      # GROUP BY uses). `nick_fold_sql/1` takes any column-expression, so the
      # folded-COALESCE index literal is single-sourced here too.
      assert Identifier.nick_fold_sql("COALESCE(dm_with, channel)") ==
               "lower(COALESCE(dm_with, channel))"
    end

    test "the #525 re-fold migration's up path embeds the ASCII fold from nick_fold_sql/1" do
      source = File.read!(@refold_migration)

      # Every live folded index the migration recreates, tied to the single
      # source so a fold change reddens here if the migration drifts.
      for col <- ["target_nick", "nick", "COALESCE(dm_with, channel)"] do
        assert String.contains?(source, Identifier.nick_fold_sql(col)),
               "#{@refold_migration} is missing #{Identifier.nick_fold_sql(col)}"
      end
    end

    test "no migration newer than the #525 re-fold reintroduces the rfc1459 fold" do
      # Lexicographic basename compare == chronological (YYYYMMDDHHMMSS
      # prefix). The re-fold migration and everything before it may carry
      # the rfc1459 literal (historical indexes / the re-fold's inverse
      # down/0); anything after must not.
      cutoff = Path.basename(@refold_migration)

      offenders =
        "priv/repo/migrations/*.exs"
        |> Path.wildcard()
        |> Enum.map(&Path.basename/1)
        |> Enum.filter(fn base ->
          base > cutoff and File.read!("priv/repo/migrations/#{base}") =~ @rfc1459_marker
        end)

      assert offenders == [],
             "these migrations reintroduce the rfc1459 fold after #525: #{inspect(offenders)}"
    end

    test "no lib/ module carries the rfc1459 fold literal (runtime folds via nick_fold*)" do
      # Post-#525 the fold is a trivial `lower()`; every runtime caller
      # derives it via nick_fold/1 / nick_fold_sql/1, and NO lib/ file —
      # not even Identifier itself — hand-writes the old rfc1459
      # four-replace form. Reintroducing it anywhere in lib/ reddens here.
      offenders =
        "lib/**/*.ex"
        |> Path.wildcard()
        |> Enum.filter(&(File.read!(&1) =~ @rfc1459_marker))

      assert offenders == [],
             "these lib/ modules carry the rfc1459 fold literal: #{inspect(offenders)}"
    end
  end
end
