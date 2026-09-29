defmodule Grappa.Session.NSInterceptorTest do
  use ExUnit.Case, async: true

  alias Grappa.Session.NSInterceptor

  # The sender's current nick — `callerUser->nick` on the services side. Only
  # SET PASSWD reads it (`do_set_password` refuses a new password equal to
  # it), so every other case goes through this default rather than repeating
  # an argument it does not use.
  @nick "caller"
  defp intercept(line), do: NSInterceptor.intercept(line, @nick)

  describe "intercept/2" do
    test "PRIVMSG NickServ :IDENTIFY pwd → {:capture, :identify, pwd}" do
      assert {:capture, :identify, "s3cret"} =
               intercept("PRIVMSG NickServ :IDENTIFY s3cret")
    end

    test "PRIVMSG NickServ :IDENTIFY account pwd → {:capture, :identify, pwd}" do
      assert {:capture, :identify, "s3cret"} =
               intercept("PRIVMSG NickServ :IDENTIFY vjt s3cret")
    end

    test "PRIVMSG NickServ :GHOST nick pwd → {:capture, :identify, pwd}" do
      assert {:capture, :identify, "s3cret"} =
               intercept("PRIVMSG NickServ :GHOST vjt s3cret")
    end

    test "PRIVMSG NickServ :REGISTER pwd email → {:capture, :register, pwd}" do
      assert {:capture, :register, "s3cret"} =
               intercept("PRIVMSG NickServ :REGISTER s3cret vjt@bad.ass")
    end

    test "case-insensitive verb match" do
      assert {:capture, :identify, "s3cret"} =
               intercept("privmsg nickserv :identify s3cret")
    end

    test "unrelated PRIVMSG → :passthrough" do
      assert :passthrough = intercept("PRIVMSG #italia :ciao")
    end

    test "PRIVMSG to non-NickServ → :passthrough" do
      assert :passthrough = intercept("PRIVMSG vjt :hello")
    end

    test "non-PRIVMSG → :passthrough" do
      assert :passthrough = intercept("JOIN #italia")
      assert :passthrough = intercept("PING :foo")
    end

    test "captures the ID alias (azzurra m_identify alias) — lone token, :identify" do
      assert {:capture, :identify, "secret"} = intercept("PRIVMSG NickServ :ID secret")
      assert {:capture, :identify, "secret"} = intercept("PRIVMSG NickServ :id secret")
    end

    test "captures SIDENTIFY (silent identify) — lone token, :identify" do
      assert {:capture, :identify, "secret"} =
               intercept("PRIVMSG NickServ :SIDENTIFY secret")
    end

    test "captures IDENTIFY/ID with an account argument — password is the second token" do
      assert {:capture, :identify, "secret"} =
               intercept("PRIVMSG NickServ :IDENTIFY myacct secret")

      assert {:capture, :identify, "secret"} =
               intercept("PRIVMSG NickServ :ID myacct secret")
    end

    test "captures a fully-qualified NickServ@services target" do
      assert {:capture, :identify, "secret"} =
               intercept("PRIVMSG NickServ@services.azzurra.chat :ID secret")
    end

    test "captures the NS / NICKSERV server-command form" do
      assert {:capture, :identify, "secret"} = intercept("NS IDENTIFY secret")
      assert {:capture, :identify, "secret"} = intercept("NS id secret")
      assert {:capture, :identify, "secret"} = intercept("NICKSERV SIDENTIFY secret")
    end

    test "captures bare IDENTIFY/ID/SIDENTIFY commands (m_identify, no PRIVMSG)" do
      assert {:capture, :identify, "secret"} = intercept("IDENTIFY secret")
      assert {:capture, :identify, "secret"} = intercept("ID secret")
      assert {:capture, :identify, "secret"} = intercept("SIDENTIFY myacct secret")
    end

    test "captures PASS post-connect identify (m_pass -> m_identify) — lone or second token, :identify" do
      assert {:capture, :identify, "secret"} = intercept("PASS secret")
      assert {:capture, :identify, "secret"} = intercept("PASS mynick secret")
    end

    test "GHOST is :identify (second token); REGISTER is :register (first token)" do
      assert {:capture, :identify, "secret"} =
               intercept("PRIVMSG NickServ :GHOST oldnick secret")

      assert {:capture, :register, "secret"} =
               intercept("PRIVMSG NickServ :REGISTER secret me@x.io")
    end

    test "NS GHOST is :identify (second token); NS REGISTER is :register (first token)" do
      assert {:capture, :identify, "secret"} = intercept("NS GHOST oldnick secret")
      assert {:capture, :register, "secret"} = intercept("NS REGISTER secret me@x.io")
    end

    # issue 2318 — `do_ghost` (`src/nickserv.c:3439`) reads `<nick> <pass>`
    # with two `strtok`s and answers NS_GHOST_SYNTAX_ERROR when the second is
    # missing; Atheme's `GHOST <target> [password]` (`ghost.c:24`) accepts the
    # one-token form from an identified caller. Either way the lone token is
    # a NICK, and capturing it staged that nick as the password — committed
    # over the real one by the next `+r` inside the window.
    test "issue 2318 — a one-token GHOST carries no password: passthrough, every form" do
      assert :passthrough = intercept("PRIVMSG NickServ :GHOST Guest12345")
      assert :passthrough = intercept("PRIVMSG NickServ@services.azzurra.chat :ghost Guest12345")
      assert :passthrough = intercept("NS GHOST Guest12345")
      assert :passthrough = intercept("NICKSERV GHOST Guest12345")
      assert :passthrough = intercept("PRIVMSG NickServ :GHOST   Guest12345   ")
    end

    # issue 2318 — every door reaches services' own `strtok(NULL, " ")` pair:
    # the ircd hands `IDENTIFY` / `NS` / `NICKSERV` ONE parameter (bahamut
    # `include/msg.h:316,324,343`, so the rest of the line arrives whole) and
    # `m_pass` joins `parv[1] parv[2]` and drops the rest. So the password is
    # the SECOND token and a third is never read — the LAST token of a longer
    # line is whatever the user typed after it, never the secret.
    test "issue 2318 — with three or more tokens the password is the SECOND, never the last" do
      assert {:capture, :identify, "s3cret"} =
               intercept("PRIVMSG NickServ :IDENTIFY vjt s3cret Guest12345")

      assert {:capture, :identify, "s3cret"} = intercept("NS ID vjt s3cret trailing words")
      assert {:capture, :identify, "s3cret"} = intercept("SIDENTIFY vjt s3cret extra")
      assert {:capture, :identify, "s3cret"} = intercept("PASS vjt s3cret extra")

      assert {:capture, :identify, "s3cret"} =
               intercept("PRIVMSG NickServ :GHOST vjt s3cret Guest12345")
    end

    test "a verb-only identify line with no password is passthrough (no empty capture)" do
      assert :passthrough = intercept("IDENTIFY   ")
      assert :passthrough = intercept("PASS  ")
      assert :passthrough = intercept("PRIVMSG NickServ :ID  ")
    end

    test "ANCHORING: a channel message that merely contains identify/pass is passthrough" do
      assert :passthrough = intercept("PRIVMSG #chan :identify yourself please")
      assert :passthrough = intercept("PRIVMSG #chan :the pass is great")
      assert :passthrough = intercept("PRIVMSG NickServ :HELP IDENTIFY")
      assert :passthrough = intercept("ISON somenick")
      assert :passthrough = intercept("IDLE foo")
    end
  end

  # #131 / #977 — in-session NickServ SET PASSWD capture. Azzurra's `do_set`
  # only routes the `PASSWD` subcommand (`PASSWORD` errors) and hands the
  # handler everything after the verb; `do_set_password` splits THAT at the
  # first space. The form is `SET PASSWD <old> <new>`, an AUTHENTICATED
  # rotation, so the capture is the SECOND token — capturing rest-of-line
  # stored `"<old> <new>"` concatenated and corrupted the credential (#977).
  # A distinct `:set_passwd` kind because the host commits it optimistically
  # on-send — NOT on a `+r` rendezvous (a SET PASSWD from an already-identified
  # session emits no `+r`) — which is exactly why a value services would
  # refuse must be rejected here rather than written and regretted.
  describe "intercept/2 — SET PASSWD (#131, #977)" do
    test "#977 — captures the NEW password (second token), never the concatenation" do
      assert {:capture, :set_passwd, "newpass"} =
               intercept("PRIVMSG NickServ :SET PASSWD oldpass newpass")
    end

    test "#977 — NS / NICKSERV / bare / fully-qualified forms all take the second token" do
      assert {:capture, :set_passwd, "newpass"} = intercept("NS SET PASSWD oldpass newpass")

      assert {:capture, :set_passwd, "newpass"} =
               intercept("NICKSERV SET PASSWD oldpass newpass")

      assert {:capture, :set_passwd, "newpass"} = intercept("SET PASSWD oldpass newpass")

      assert {:capture, :set_passwd, "newpass"} =
               intercept("PRIVMSG NickServ@services.azzurra.chat :SET PASSWD oldpass newpass")
    end

    test "case-insensitive (cic forwards /ns set passwd verbatim, lower-cased)" do
      assert {:capture, :set_passwd, "newpass"} =
               intercept("privmsg nickserv :set passwd oldpass newpass")
    end

    test "#977 — one-token SET PASSWD <new> is a services syntax error, not a capture" do
      assert {:reject, :set_passwd, :syntax_error} =
               intercept("PRIVMSG NickServ :SET PASSWD newpass")

      assert {:reject, :set_passwd, :syntax_error} = intercept("NS SET PASSWD newpass")
    end

    test "#977 — a TAB is not a services delimiter, so old\\tnew is one token" do
      assert {:reject, :set_passwd, :syntax_error} =
               intercept("PRIVMSG NickServ :SET PASSWD oldpass\tnewpass")
    end

    test "verb-only SET PASSWD carries no password at all" do
      assert {:reject, :set_passwd, :syntax_error} = intercept("PRIVMSG NickServ :SET PASSWD")
      assert {:reject, :set_passwd, :syntax_error} = intercept("SET PASSWD")
    end

    test "#977 — a new password with a space is refused (CSNS_ERROR_PASSWORD_WITH_SPACES)" do
      assert {:reject, :set_passwd, :password_with_spaces} =
               intercept("PRIVMSG NickServ :SET PASSWD oldpass my new pass")

      # Trailing space: services trim nothing, so `newpass` ends in one.
      assert {:reject, :set_passwd, :password_with_spaces} =
               intercept("PRIVMSG NickServ :SET PASSWD oldpass newpass ")

      # A doubled space after the verb makes the OLD password empty and the
      # new one "oldpass newpass" — services refuse that too.
      assert {:reject, :set_passwd, :password_with_spaces} =
               intercept("PRIVMSG NickServ :SET PASSWD  oldpass newpass")

      assert {:reject, :set_passwd, :password_with_spaces} =
               intercept("PRIVMSG NickServ :SET PASSWD   ")
    end

    test "#977 — under 5 bytes is refused; exactly 5 is accepted" do
      assert {:reject, :set_passwd, :insecure_password} =
               intercept("PRIVMSG NickServ :SET PASSWD oldpass abcd")

      assert {:capture, :set_passwd, "abcde"} =
               intercept("PRIVMSG NickServ :SET PASSWD oldpass abcde")
    end

    test "#977 — a new password equal to the caller's nick is refused, any case" do
      assert {:reject, :set_passwd, :insecure_password} =
               NSInterceptor.intercept("SET PASSWD oldpass CaLLer", "caller")

      assert {:reject, :set_passwd, :insecure_password} =
               NSInterceptor.intercept("SET PASSWD oldpass caller", "CALLER")

      assert {:capture, :set_passwd, "caller1"} =
               NSInterceptor.intercept("SET PASSWD oldpass caller1", "caller")
    end

    test "#977 — over PASSMAX (32 bytes) is refused; exactly 32 is accepted" do
      max = String.duplicate("a", 32)

      assert {:capture, :set_passwd, ^max} = intercept("SET PASSWD oldpass #{max}")

      assert {:reject, :set_passwd, :password_max_length} =
               intercept("SET PASSWD oldpass #{max <> "a"}")
    end

    test "#977 — control codes are refused, counted per BYTE like string_has_ccodes" do
      assert {:reject, :set_passwd, :password_with_ccodes} =
               intercept("SET PASSWD oldpass new\x02pass")

      # `à` is C3 A0 in UTF-8 and 160 is a control code to services, so an
      # accented password is refused upstream — and therefore here.
      assert {:reject, :set_passwd, :password_with_ccodes} =
               intercept("SET PASSWD oldpass pàssword")
    end

    test "SET PASSWORD is NOT matched — Azzurra verb is PASSWD, PASSWORD errors" do
      assert :passthrough = intercept("PRIVMSG NickServ :SET PASSWORD oldpass newpass")
      assert :passthrough = intercept("NS SET PASSWORD oldpass newpass")
      assert :passthrough = intercept("SET PASSWORD oldpass newpass")
    end

    test "other SET subcommands (EMAIL etc.) are passthrough — only PASSWD is captured" do
      assert :passthrough = intercept("PRIVMSG NickServ :SET EMAIL me@x.io")
      assert :passthrough = intercept("NS SET HIDE ON")
    end

    test "ANCHORING: a channel message / HELP that merely contains SET PASSWD is passthrough" do
      assert :passthrough = intercept("PRIVMSG #chan :SET PASSWD oldpass lol")
      assert :passthrough = intercept("PRIVMSG NickServ :HELP SET PASSWD")
    end
  end

  # #978 — the account-recovery sibling. `do_resetpass` takes THREE
  # `strtok(NULL, " ")` — nick, code, new password — so the secret is the
  # third TOKEN, and everything after it is discarded by services. The
  # capture carries the target nick too: RESETPASS names the account it
  # rotates, and only the host knows whether that account is ours.
  describe "intercept/2 — RESETPASS (#978)" do
    test "PRIVMSG NickServ :RESETPASS nick code new → captures the THIRD token" do
      assert {:capture, :reset_passwd, "vjt", "newpassword"} =
               intercept("PRIVMSG NickServ :RESETPASS vjt 12345 newpassword")
    end

    test "NS / NICKSERV RESETPASS server-command form" do
      assert {:capture, :reset_passwd, "vjt", "newpassword"} =
               intercept("NS RESETPASS vjt 12345 newpassword")

      assert {:capture, :reset_passwd, "vjt", "newpassword"} =
               intercept("NICKSERV RESETPASS vjt 12345 newpassword")
    end

    test "fully-qualified NickServ@services target" do
      assert {:capture, :reset_passwd, "vjt", "newpassword"} =
               intercept("PRIVMSG NickServ@services.azzurra.chat :RESETPASS vjt 12345 newpassword")
    end

    test "case-insensitive verb match" do
      assert {:capture, :reset_passwd, "vjt", "newpassword"} =
               intercept("privmsg nickserv :resetpass vjt 12345 newpassword")
    end

    test "there is NO bare form — RESETPASS is not an ircd command" do
      assert :passthrough = intercept("RESETPASS vjt 12345 newpassword")
    end

    test "a fourth token is DISCARDED — strtok stops at the third" do
      assert {:capture, :reset_passwd, "vjt", "newpassword"} =
               intercept("NS RESETPASS vjt 12345 newpassword and more")
    end

    test "runs of spaces collapse — strtok skips its delimiters" do
      assert {:capture, :reset_passwd, "vjt", "newpassword"} =
               intercept("NS RESETPASS  vjt   12345   newpassword  ")
    end

    test "fewer than three tokens is a syntax error upstream — never a capture" do
      assert {:reject, :reset_passwd, :syntax_error} =
               intercept("NS RESETPASS")

      assert {:reject, :reset_passwd, :syntax_error} =
               intercept("NS RESETPASS vjt")

      assert {:reject, :reset_passwd, :syntax_error} =
               intercept("PRIVMSG NickServ :RESETPASS vjt 12345")

      # Trailing space: services' third `strtok` still returns NULL.
      assert {:reject, :reset_passwd, :syntax_error} =
               intercept("PRIVMSG NickServ :RESETPASS vjt 12345 ")
    end

    test "a password under 5 bytes is refused (CSNS_ERROR_INSECURE_PASSWORD)" do
      assert {:reject, :reset_passwd, :insecure_password} =
               intercept("NS RESETPASS vjt 12345 abcd")
    end

    test "a password equal to the TARGET nick is refused, case-insensitively" do
      assert {:reject, :reset_passwd, :insecure_password} =
               intercept("NS RESETPASS vjtvjt 12345 VJTVJT")
    end

    test "that compare is against the reset TARGET, not the caller's nick" do
      # `do_resetpass` checks `ni->nick`, the nick being reset — unlike
      # `do_set_password`, which checks `callerUser->nick` (`@nick` here).
      assert {:capture, :reset_passwd, "othernick", @nick} =
               intercept("NS RESETPASS othernick 12345 #{@nick}")

      assert {:reject, :reset_passwd, :insecure_password} =
               intercept("NS RESETPASS #{@nick} 12345 #{String.upcase(@nick)}")
    end

    test "a password over PASSMAX=32 bytes is refused" do
      assert {:reject, :reset_passwd, :password_max_length} =
               intercept("NS RESETPASS vjt 12345 #{String.duplicate("a", 33)}")

      assert {:capture, :reset_passwd, "vjt", _} =
               intercept("NS RESETPASS vjt 12345 #{String.duplicate("a", 32)}")
    end

    test "control codes are refused — including the byte 160 string_has_ccodes rejects" do
      assert {:reject, :reset_passwd, :password_with_ccodes} =
               intercept("NS RESETPASS vjt 12345 new\x02pass")

      # A TAB is not a strtok(" ") delimiter, so it lands INSIDE the token —
      # and services refuse it as a control code.
      assert {:reject, :reset_passwd, :password_with_ccodes} =
               intercept("NS RESETPASS vjt 12345 new\tpass")

      assert {:reject, :reset_passwd, :password_with_ccodes} =
               intercept("NS RESETPASS vjt 12345 new" <> <<160>> <> "pass")
    end

    test "ANCHORING: a channel message / HELP that merely contains RESETPASS is passthrough" do
      assert :passthrough = intercept("PRIVMSG #chan :RESETPASS vjt 12345 lolwhat")
      assert :passthrough = intercept("PRIVMSG NickServ :HELP RESETPASS")
    end
  end
end
