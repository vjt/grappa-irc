defmodule Grappa.IRC.DCCTest do
  use ExUnit.Case, async: true

  use ExUnitProperties

  alias Grappa.IRC.{CTCP, DCC}
  alias Grappa.Net.Ssrf

  # issue 2089 — the wire half of a DCC SEND offer, and ONLY the wire half.
  # `parse/1` takes the CTCP argument remainder (what `CTCP.verb_args/1`
  # already returns for a `\x01DCC …\x01` body) so there is one CTCP framing
  # parser in this codebase, not two.

  describe "parse/1 — the classic active offer" do
    test "a SEND offer with the 32-bit integer address parses into a v4 tuple" do
      assert {:ok, offer} = DCC.parse("SEND report.pdf 3221225985 5000 12345")

      assert %DCC{
               filename: "report.pdf",
               ip: {192, 0, 2, 1},
               port: 5000,
               size: 12_345,
               token: nil
             } = offer
    end

    test "the address integer is network byte order — highest octet first" do
      # 0xC0000201 == 192.0.2.1. A little-endian decode would answer
      # {1, 2, 0, 192}, which is a different (and reserved) host.
      assert {:ok, %DCC{ip: {192, 0, 2, 1}}} = DCC.parse("SEND f 3221225985 1 1")
    end

    test "the boundary integers 0 and 2^32-1 decode to the edge addresses" do
      assert {:ok, %DCC{ip: {0, 0, 0, 0}}} = DCC.parse("SEND f 0 1 1")
      assert {:ok, %DCC{ip: {255, 255, 255, 255}}} = DCC.parse("SEND f 4294967295 1 1")
    end

    test "a dotted-quad address is accepted and yields the same tuple as its integer" do
      # Not the historical field form, but clients emit it. Accepting it costs
      # one clause (the v6 literal path already needs :inet) and refusing it
      # would drop an offer we can otherwise honour.
      assert {:ok, %DCC{ip: {192, 0, 2, 1}}} = DCC.parse("SEND f 192.0.2.1 5000 1")
    end

    test "an IPv6 literal address parses into a v6 tuple" do
      assert {:ok, %DCC{ip: {0x2001, 0xDB8, 0, 0, 0, 0, 0, 1}}} =
               DCC.parse("SEND f 2001:db8::1 5000 1")
    end

    test "a zero-byte file is a legal offer" do
      assert {:ok, %DCC{size: 0}} = DCC.parse("SEND empty.txt 3221225985 5000 0")
    end
  end

  describe "parse/1 — filenames" do
    test "a quoted filename preserves its interior spaces" do
      assert {:ok, %DCC{filename: "my holiday photo.jpg", port: 5000}} =
               DCC.parse(~s(SEND "my holiday photo.jpg" 3221225985 5000 99))
    end

    test "an unquoted filename with spaces is recovered right-to-left" do
      # The trailing fields are fixed-arity, so everything before them is the
      # name — the only way to read the shape the CTCP cannot quote.
      assert {:ok, %DCC{filename: "my holiday photo.jpg", size: 99}} =
               DCC.parse("SEND my holiday photo.jpg 3221225985 5000 99")
    end

    test "a blank quoted filename is malformed" do
      assert {:error, :malformed} = DCC.parse(~s(SEND "" 3221225985 5000 1))
      assert {:error, :malformed} = DCC.parse(~s(SEND "   " 3221225985 5000 1))
    end

    test "a quoted filename with no closing quote is malformed" do
      assert {:error, :malformed} = DCC.parse(~s(SEND "unterminated 3221225985 5000 1))
    end

    test "a missing filename is malformed" do
      assert {:error, :malformed} = DCC.parse("SEND 3221225985 5000 1")
    end

    test "a traversal-shaped filename is returned VERBATIM, never sanitised here" do
      # Deliberate: this module reports what the wire said. Nothing downstream
      # may use a peer filename as a path — `Grappa.Uploads.storage_path/2`
      # derives the on-disk name from the 26-char base32 slug and RAISES on
      # anything else. Sanitising here would invent a second, weaker guard and
      # would silently corrupt the display name.
      assert {:ok, %DCC{filename: "../../etc/passwd"}} =
               DCC.parse("SEND ../../etc/passwd 3221225985 5000 1")
    end
  end

  describe "parse/1 — passive (reverse) offers" do
    test "port 0 with a trailing token parses as a passive offer" do
      assert {:ok, %DCC{filename: "f", port: 0, size: 10, token: 7}} =
               DCC.parse("SEND f 3221225985 0 10 7")
    end

    test "a passive offer keeps an unquoted spaced filename intact" do
      assert {:ok, %DCC{filename: "two words.bin", port: 0, token: 42}} =
               DCC.parse("SEND two words.bin 3221225985 0 10 42")
    end

    test "port 0 WITHOUT a token is malformed — it can be neither dialled nor answered" do
      assert {:error, :malformed} = DCC.parse("SEND f 3221225985 0 10")
    end

    test "a non-numeric token is malformed" do
      assert {:error, :malformed} = DCC.parse("SEND f 3221225985 0 10 abc")
    end

    test "a spaced filename in front of an address of 0 keeps the ACTIVE reading" do
      # The four-field tail here is `file 0 10 7`, which LOOKS passive until
      # you ask whether `file` decodes as an address. It does not, so the
      # true reading survives: name "my file", address 0.0.0.0, port 10.
      assert {:ok, %DCC{filename: "my file", ip: {0, 0, 0, 0}, port: 10, size: 7, token: nil}} =
               DCC.parse("SEND my file 0 10 7")
    end
  end

  describe "parse/1 — refusals" do
    test "an address integer above 2^32-1 is malformed" do
      assert {:error, :malformed} = DCC.parse("SEND f 4294967296 5000 1")
    end

    test "a non-strict address literal is malformed, never decoded into loopback" do
      # Same posture as `Grappa.Net.Ssrf`: an octal/short form must NOT be
      # decoded into a loopback address behind the caller's back. The two
      # cases reach the refusal by DIFFERENT routes, which is why both are
      # here: `017700000001` is all digits, so it takes the 32-bit integer
      # path and dies on the range check (it is 17_700_000_001); `127.1`
      # takes the literal path and dies in `:inet.parse_strict_address/1`.
      assert {:error, :malformed} = DCC.parse("SEND f 017700000001 5000 1")
      assert {:error, :malformed} = DCC.parse("SEND f 127.1 5000 1")
    end

    test "a port above 65535 is malformed" do
      assert {:error, :malformed} = DCC.parse("SEND f 3221225985 65536 1")
    end

    test "a negative or non-numeric size is malformed" do
      assert {:error, :malformed} = DCC.parse("SEND f 3221225985 5000 -1")
      assert {:error, :malformed} = DCC.parse("SEND f 3221225985 5000 lots")
    end

    test "the historical sizeless form is refused" do
      # `DCC SEND <file> <addr> <port>` with no size exists in pre-1996
      # clients. It is refused on purpose: with no declared size a receiver
      # cannot check its cap BEFORE dialling, and the unquoted-filename
      # right-to-left split stops being decidable.
      assert {:error, :malformed} = DCC.parse("SEND f 3221225985 5000")
    end

    test "empty args are malformed" do
      assert {:error, :malformed} = DCC.parse("")
      assert {:error, :malformed} = DCC.parse("   ")
    end
  end

  describe "parse/1 — verb discrimination" do
    test "the SEND verb matches case-insensitively (ASCII)" do
      assert {:ok, %DCC{filename: "f"}} = DCC.parse("send f 3221225985 5000 1")
      assert {:ok, %DCC{filename: "f"}} = DCC.parse("Send f 3221225985 5000 1")
    end

    test "DCC CHAT reports its verb — never a false offer" do
      assert {:error, {:unsupported_verb, "CHAT"}} = DCC.parse("CHAT chat 3221225985 5000")
    end

    test "RESUME and ACCEPT report their verb rather than lying about the shape" do
      # Whether grappa answers a resume is an OPEN product decision (issue
      # 2089's "protocol edges"). Reporting the verb keeps that decision
      # outside this module — `:malformed` would have been a lie.
      assert {:error, {:unsupported_verb, "RESUME"}} = DCC.parse("RESUME f 5000 1024")
      assert {:error, {:unsupported_verb, "ACCEPT"}} = DCC.parse("ACCEPT f 5000 1024")
    end

    test "an unknown verb is reported verbatim, uppercased" do
      assert {:error, {:unsupported_verb, "XMIT"}} = DCC.parse("xmit f 1 2 3")
    end

    test "a bare verb with no arguments is still a verb, not malformed" do
      assert {:error, {:unsupported_verb, "CHAT"}} = DCC.parse("CHAT")
    end
  end

  describe "composition with the existing CTCP and SSRF primitives" do
    test "the whole framed body routes through CTCP.verb_args/1 into parse/1" do
      body = "\x01DCC SEND report.pdf 3221225985 5000 12345\x01"

      assert {"DCC", args} = CTCP.verb_args(body)
      assert {:ok, %DCC{filename: "report.pdf", port: 5000}} = DCC.parse(args)
    end

    test "the parsed address feeds Ssrf.safe_public_ip?/1 with no conversion" do
      # The whole point of decoding to an `:inet.ip_address()` here: the
      # eventual dial site hands the tuple straight to the guard this repo
      # already hardened, instead of re-deriving one.
      assert {:ok, %DCC{ip: public}} = DCC.parse("SEND f 3221225985 5000 1")
      assert Ssrf.safe_public_ip?(public)

      assert {:ok, %DCC{ip: loopback}} = DCC.parse("SEND f 2130706433 5000 1")
      refute Ssrf.safe_public_ip?(loopback)

      assert {:ok, %DCC{ip: v6_loopback}} = DCC.parse("SEND f ::1 5000 1")
      refute Ssrf.safe_public_ip?(v6_loopback)

      assert {:ok, %DCC{ip: mapped}} = DCC.parse("SEND f ::ffff:127.0.0.1 5000 1")
      refute Ssrf.safe_public_ip?(mapped)
    end
  end

  describe "properties" do
    property "any four octets round-trip through the 32-bit integer field" do
      check all(
              a <- integer(0..255),
              b <- integer(0..255),
              c <- integer(0..255),
              d <- integer(0..255)
            ) do
        n = a * 16_777_216 + b * 65_536 + c * 256 + d

        assert {:ok, %DCC{ip: {^a, ^b, ^c, ^d}}} = DCC.parse("SEND f #{n} 5000 1")
      end
    end

    property "a filename of N space-separated words survives the right-to-left split" do
      check all(words <- list_of(string(?a..?z, min_length: 1), min_length: 1, max_length: 6)) do
        name = Enum.join(words, " ")

        assert {:ok, %DCC{filename: ^name}} = DCC.parse("SEND #{name} 3221225985 5000 1")
      end
    end

    property "never raises on arbitrary argument bytes" do
      check all(args <- string(:printable, max_length: 40)) do
        assert match?({:ok, %DCC{}}, DCC.parse(args)) or
                 match?({:error, _}, DCC.parse(args))
      end
    end
  end
end
