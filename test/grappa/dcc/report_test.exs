defmodule Grappa.Dcc.ReportTest do
  use ExUnit.Case, async: true

  alias Grappa.Dcc.Report
  alias Grappa.IRC.Message

  @peer "Vjt"

  describe "render/2 — a delivered file is the peer speaking" do
    test "is attributed to the peer's nick, RAW-cased" do
      report = Report.render({:delivered, "archive.zip", "https://example.test/dcc/abc"}, @peer)

      assert report.sender == @peer
      assert report.kind == :privmsg
    end

    test "carries the filename and the link" do
      report = Report.render({:delivered, "archive.zip", "https://example.test/dcc/abc"}, @peer)

      assert report.body =~ "archive.zip"
      assert report.body =~ "https://example.test/dcc/abc"
    end

    test "is prefixed with an emoji OUTSIDE cic's inline-media set" do
      # cic's mediaLink.ts keys inline rendering off a CLOSED emoji map
      # (📸 image / 🎬 video / 🎵 audio). A DCC file is arbitrary
      # stranger-pushed bytes served as octet-stream + attachment, and
      # issue 2089 forbids any sniff that PROMOTES a type — so the
      # prefix must not be one cic renders. This asserts the property,
      # not the decoration.
      report = Report.render({:delivered, "a.bin", "https://example.test/dcc/abc"}, @peer)

      assert report.body =~ "📥"
      refute report.body =~ "📸"
      refute report.body =~ "🎬"
      refute report.body =~ "🎵"
    end
  end

  describe "render/2 — a failure is GRAPPA speaking, never the peer" do
    # Attributing "the connection was refused" to the peer's nick would
    # put words in a stranger's mouth in the user's own scrollback. The
    # tree already has the closed-set value for "nobody said this and it
    # did not come off the wire", and the `$server` link-failure row is
    # the precedent this follows.
    for {label, failure} <- [
          {"a refused connection", :connect_refused},
          {"a connect timeout", :connect_timeout},
          {"a stalled sender", :idle_timeout},
          {"a truncated transfer", {:short_transfer, 40, 100}},
          {"a network error", {:tcp, :ehostunreach}},
          {"a storage error", {:fs, :enospc}}
        ] do
      test "#{label} is anonymous and event-tier" do
        report = Report.render({:failed, "a.bin", unquote(Macro.escape(failure))}, @peer)

        assert report.sender == Message.anonymous_sender()
        assert report.kind == :server_event
      end

      test "#{label} still names the peer in the text, so the user knows whose transfer failed" do
        report = Report.render({:failed, "a.bin", unquote(Macro.escape(failure))}, @peer)

        assert report.body =~ @peer
      end

      test "#{label} produces a non-empty body — silence is the one forbidden outcome" do
        report = Report.render({:failed, "a.bin", unquote(Macro.escape(failure))}, @peer)

        assert is_binary(report.body)
        assert String.trim(report.body) != ""
      end
    end

    test "a truncated transfer reports both counts — 'it failed' alone does not tell the user how far it got" do
      report = Report.render({:failed, "a.bin", {:short_transfer, 40, 100}}, @peer)

      assert report.body =~ "40"
      assert report.body =~ "100"
    end

    test "distinct failures produce distinct text — a shared message would hide which one happened" do
      failures = [
        :connect_refused,
        :connect_timeout,
        :idle_timeout,
        {:short_transfer, 40, 100},
        {:tcp, :ehostunreach},
        {:fs, :enospc}
      ]

      bodies = Enum.map(failures, fn f -> Report.render({:failed, "a.bin", f}, @peer).body end)

      assert length(Enum.uniq(bodies)) == length(bodies)
    end
  end

  describe "render/2 — a refused offer is reported, not dropped" do
    for {label, refusal} <- [
          {"passive DCC", :passive_unsupported},
          {"an unsupported subcommand", {:unsupported_subcommand, "RESUME"}},
          {"a malformed offer", :malformed}
        ] do
      test "#{label} is anonymous, event-tier and non-empty" do
        report = Report.render({:refused, unquote(Macro.escape(refusal))}, @peer)

        assert report.sender == Message.anonymous_sender()
        assert report.kind == :server_event
        assert String.trim(report.body) != ""
        assert report.body =~ @peer
      end
    end

    test "an unsupported subcommand names the verb it declined" do
      report = Report.render({:refused, {:unsupported_subcommand, "RESUME"}}, @peer)

      assert report.body =~ "RESUME"
    end

    test "the three refusals read differently from one another" do
      bodies =
        Enum.map(
          [:passive_unsupported, {:unsupported_subcommand, "RESUME"}, :malformed],
          fn r -> Report.render({:refused, r}, @peer).body end
        )

      assert length(Enum.uniq(bodies)) == 3
    end
  end

  describe "render/2 — the peer-supplied filename is neutralised for DISPLAY" do
    # The parser preserves the filename verbatim on purpose (it is
    # evidence of what the peer sent). THIS is the display boundary, so
    # this is where it gets made safe to render.
    test "control bytes are stripped — a CTCP or mIRC-colour byte must not reach a rendered row" do
      report = Report.render({:delivered, "ev\x03il\x01.zip", "https://example.test/x"}, @peer)

      refute report.body =~ "\x03"
      refute report.body =~ "\x01"
    end

    test "newlines are stripped — a filename must not forge a second line" do
      report = Report.render({:delivered, "a\r\nPRIVMSG #chan :owned", "https://example.test/x"}, @peer)

      refute report.body =~ "\n"
      refute report.body =~ "\r"
    end

    test "an absurdly long filename is capped so one offer cannot flood the row" do
      report = Report.render({:delivered, String.duplicate("a", 4_000), "https://example.test/x"}, @peer)

      assert byte_size(report.body) < 1_000
    end

    test "an all-control filename still yields a usable line rather than an empty name" do
      report = Report.render({:delivered, "\x01\x02\x03", "https://example.test/x"}, @peer)

      assert String.trim(report.body) != ""
      assert report.body =~ "https://example.test/x"
    end

    test "an ordinary unicode filename survives intact — the strip is control bytes, not non-ASCII" do
      report = Report.render({:delivered, "relazione-annuale-è.pdf", "https://example.test/x"}, @peer)

      assert report.body =~ "relazione-annuale-è.pdf"
    end

    test "the same neutralisation applies on the failure path" do
      report = Report.render({:failed, "ev\x03il\r\n.zip", :connect_refused}, @peer)

      refute report.body =~ "\x03"
      refute report.body =~ "\n"
    end
  end
end
