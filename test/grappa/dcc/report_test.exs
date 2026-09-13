defmodule Grappa.Dcc.ReportTest do
  use ExUnit.Case, async: true

  alias Grappa.Dcc
  alias Grappa.Dcc.{Policy, Report}
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

  describe "render/2 — a POLICY refusal names the axis, not just the verdict" do
    # Three independent axes (address class, size, rate) plus the disk
    # budget and the held-set ceiling. They stayed separate atoms so the
    # sentence tells the operator what to DO: ask for a smaller file, stop
    # talking to this peer, or come back tomorrow. A single "refused"
    # would say none of that.
    test "an unroutable address says the bouncer will not dial it" do
      report = Report.render({:refused, :ssrf_blocked}, @peer)

      assert report.kind == :server_event
      assert report.body =~ "not one this bouncer will dial"
    end

    test "an oversized offer quotes the actual ceiling, not a restated number" do
      report = Report.render({:refused, :too_large}, @peer)

      # Read off production, so a change to the cap moves the sentence and
      # a hardcoded expectation here cannot rot into a lie.
      assert report.body =~ "#{div(Dcc.max_transfer_bytes(), 1024 * 1024)} MB"
    end

    test "a spent daily allowance quotes the actual allowance" do
      report = Report.render({:refused, :rate_limited}, @peer)

      assert report.body =~ "#{Policy.daily_accepts()}"
      assert report.body =~ "today"
    end

    test "a full spool blames the spool, not the operator" do
      report = Report.render({:refused, :insufficient_storage}, @peer)

      assert report.body =~ "no room"
    end

    test "a flooded held set is reported too — a silent drop is the one forbidden outcome" do
      report = Report.render({:refused, :too_many_offers}, @peer)

      assert report.body =~ "waiting for an answer"
    end

    test "every policy refusal is GRAPPA speaking, never the peer" do
      # The attribution split holds across the whole vocabulary: none of
      # these sentences was uttered by the sender, so none of them may
      # carry their nick.
      for reason <- [:ssrf_blocked, :too_large, :rate_limited, :insufficient_storage, :too_many_offers] do
        report = Report.render({:refused, reason}, @peer)

        assert report.kind == :server_event, "#{reason} was attributed to the peer"
        assert report.sender == Message.anonymous_sender()
      end
    end

    test "every refusal in the closed set renders a distinct, non-empty sentence" do
      # A reason that fell through to a generic string would be a silent
      # loss of exactly the information the axes were split to preserve.
      reasons = [
        :passive_unsupported,
        {:unsupported_subcommand, "CHAT"},
        :malformed,
        :ssrf_blocked,
        :too_large,
        :rate_limited,
        :insufficient_storage,
        :too_many_offers
      ]

      bodies = Enum.map(reasons, &Report.render({:refused, &1}, @peer).body)

      assert Enum.uniq(bodies) == bodies
      refute Enum.any?(bodies, &(String.trim(&1) == ""))
    end
  end

  describe "display_filename/1 — the banner and the row name the file identically" do
    # Public so `Session.Wire.dcc_offer/6` can carry the SAME string the
    # scrollback row will. Two neutralisations would be one drift away from
    # a consent banner and its outcome row disagreeing about what was sent,
    # which is the one place a reader compares them.
    test "it is the row's name without the row's quotes" do
      # Not a restatement of the expected string: the row is asked what it
      # printed, so a change to either side that does not move the other
      # fails here.
      report = Report.render({:delivered, "holiday.tar.gz", "https://example.test/x"}, @peer)

      assert Report.display_filename("holiday.tar.gz") == "holiday.tar.gz"
      assert report.body =~ ~s{"#{Report.display_filename("holiday.tar.gz")}"}
    end

    test "it neutralises exactly what the row neutralises" do
      assert Report.display_filename("ev\x03il\r\n.zip") == "evil.zip"
      assert byte_size(Report.display_filename(String.duplicate("a", 4_000))) < 1_000
    end

    test "a nameless offer collapses to a printable sentinel, not to an empty field" do
      # An empty `filename` on the wire would render as a banner offering
      # nothing, with no way to tell it from a missing key.
      assert Report.display_filename("\x01\x02\x03") == "(unnamed)"
      assert Report.display_filename("   ") == "(unnamed)"
    end

    test "a peer who literally names a file (unnamed) is still quoted in the row" do
      # The sentinel is this module speaking and goes unquoted; a name the
      # peer chose is quoted even when it collides with the sentinel, so the
      # row never silently reports a named file as nameless.
      report = Report.render({:delivered, "(unnamed)", "https://example.test/x"}, @peer)

      assert report.body =~ ~s{"(unnamed)"}
    end
  end
end
