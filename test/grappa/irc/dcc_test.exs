defmodule Grappa.IRC.DCCTest do
  use ExUnit.Case, async: true

  alias Grappa.IRC.DCC
  alias Grappa.IRC.DCC.Offer

  # 16_909_060 == 1.2.3.4 — the historical DCC address field is a 32-bit
  # unsigned integer in network byte order, so every classic sender puts
  # an IPv4 address there in decimal.
  @v4_int "16909060"
  @v4_tuple {1, 2, 3, 4}

  describe "parse/1 — the accepted shape" do
    test "classic IPv4-as-integer SEND yields a typed offer" do
      assert {:ok, offer} = DCC.parse("SEND archive.zip #{@v4_int} 5000 12345")

      assert %Offer{
               filename: "archive.zip",
               ip: @v4_tuple,
               port: 5000,
               size: 12_345
             } = offer
    end

    test "IPv6 literal address is accepted — the de-facto form, since the historical field is v4-only" do
      assert {:ok, %Offer{ip: {0x2001, 0x0DB8, 0, 0, 0, 0, 0, 1}, port: 5000}} =
               DCC.parse("SEND archive.zip 2001:db8::1 5000 12345")
    end

    test "dotted-quad IPv4 is accepted alongside the integer form" do
      assert {:ok, %Offer{ip: @v4_tuple}} = DCC.parse("SEND archive.zip 1.2.3.4 5000 12345")
    end

    test "a quoted filename preserves its interior spaces" do
      assert {:ok, %Offer{filename: "my holiday photo.jpg"}} =
               DCC.parse(~s{SEND "my holiday photo.jpg" #{@v4_int} 5000 12345})
    end

    test "a zero-byte declared size parses — the cap axis rejects it, not the parser" do
      assert {:ok, %Offer{size: 0}} = DCC.parse("SEND empty.bin #{@v4_int} 5000 0")
    end

    test "the highest legal port parses" do
      assert {:ok, %Offer{port: 65_535}} = DCC.parse("SEND a.bin #{@v4_int} 65535 1")
    end
  end

  describe "parse/1 — the filename is untrusted DISPLAY metadata, never a path" do
    # The on-disk name is a minted slug (the `Grappa.Avatars` precedent);
    # this field is only ever shown to a human. The parser therefore
    # preserves it verbatim rather than sanitising — a parser that
    # silently rewrote it would hide what the peer actually sent from
    # the code that has to decide whether to display it.
    test "a traversal-shaped filename round-trips verbatim rather than being rewritten" do
      assert {:ok, %Offer{filename: "../../etc/passwd"}} =
               DCC.parse("SEND ../../etc/passwd #{@v4_int} 5000 12345")
    end

    test "an absolute-path-shaped filename round-trips verbatim" do
      assert {:ok, %Offer{filename: "/etc/shadow"}} =
               DCC.parse("SEND /etc/shadow #{@v4_int} 5000 12345")
    end
  end

  describe "parse/1 — passive (reverse) DCC is refused" do
    # Passive DCC inverts the roles: port 0 means "you listen, I connect".
    # Receive-only exists precisely because we never listen, so this is
    # the one refusal that keeps that property true.
    test "port 0 is refused even without a token" do
      assert {:error, :passive_unsupported} = DCC.parse("SEND a.bin #{@v4_int} 0 12345")
    end

    test "the five-token token-carrying form is refused" do
      assert {:error, :passive_unsupported} =
               DCC.parse("SEND a.bin #{@v4_int} 0 12345 489335159")
    end

    test "a token alongside a NON-zero port is still refused" do
      assert {:error, :passive_unsupported} =
               DCC.parse("SEND a.bin #{@v4_int} 5000 12345 489335159")
    end
  end

  describe "parse/1 — every other subcommand is an honest refusal" do
    test "RESUME is refused by name, not silently ignored" do
      assert {:error, {:unsupported_subcommand, "RESUME"}} =
               DCC.parse("RESUME a.bin 5000 1000")
    end

    test "ACCEPT is refused by name" do
      assert {:error, {:unsupported_subcommand, "ACCEPT"}} =
               DCC.parse("ACCEPT a.bin 5000 1000")
    end

    test "CHAT is refused by name" do
      assert {:error, {:unsupported_subcommand, "CHAT"}} =
               DCC.parse("CHAT chat #{@v4_int} 5000")
    end

    test "the subcommand match is case-insensitive — senders vary" do
      assert {:ok, %Offer{}} = DCC.parse("send a.bin #{@v4_int} 5000 1")
      assert {:error, {:unsupported_subcommand, "RESUME"}} = DCC.parse("resume a.bin 5000 1000")
    end
  end

  describe "parse/1 — malformed input" do
    test "an empty argument string is malformed" do
      assert {:error, :malformed} = DCC.parse("")
    end

    test "a bare subcommand with no arguments is malformed" do
      assert {:error, :malformed} = DCC.parse("SEND")
    end

    test "a missing size field is malformed" do
      assert {:error, :malformed} = DCC.parse("SEND a.bin #{@v4_int} 5000")
    end

    test "an unquoted filename containing spaces is refused rather than guessed" do
      # Classic senders quote such names. Guessing the split would make
      # the address field position depend on the filename's content.
      assert {:error, :malformed} = DCC.parse("SEND my holiday photo.jpg #{@v4_int} 5000 12345")
    end

    test "a non-numeric port is malformed" do
      assert {:error, :malformed} = DCC.parse("SEND a.bin #{@v4_int} http 12345")
    end

    test "a port above 65535 is malformed" do
      assert {:error, :malformed} = DCC.parse("SEND a.bin #{@v4_int} 65536 12345")
    end

    test "a negative size is malformed" do
      assert {:error, :malformed} = DCC.parse("SEND a.bin #{@v4_int} 5000 -1")
    end

    test "an address integer above the 32-bit range is malformed" do
      assert {:error, :malformed} = DCC.parse("SEND a.bin 4294967296 5000 12345")
    end

    test "the zero-padded octal-looking address form is NOT decoded to loopback" do
      # `017700000001` is the classic loopback-smuggling form. It exceeds
      # the 32-bit range when read as decimal and is not a strict literal,
      # so both doors are shut. Asserting it here pins the property: this
      # must never become 127.0.0.1.
      assert {:error, :malformed} = DCC.parse("SEND a.bin 017700000001 5000 12345")
    end

    test "a zero-padded dotted quad is refused — strict literal parsing only" do
      assert {:error, :malformed} = DCC.parse("SEND a.bin 010.0.0.1 5000 12345")
    end

    test "a hostname in the address field is malformed — DCC carries an address, never a name" do
      assert {:error, :malformed} = DCC.parse("SEND a.bin evil.example.com 5000 12345")
    end

    test "an unterminated quoted filename is malformed" do
      assert {:error, :malformed} = DCC.parse(~s{SEND "unterminated #{@v4_int} 5000 12345})
    end
  end
end
