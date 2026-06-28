defmodule Grappa.Session.NSInterceptorTest do
  use ExUnit.Case, async: true

  alias Grappa.Session.NSInterceptor

  describe "intercept/1" do
    test "PRIVMSG NickServ :IDENTIFY pwd → {:capture, :identify, pwd}" do
      assert {:capture, :identify, "s3cret"} =
               NSInterceptor.intercept("PRIVMSG NickServ :IDENTIFY s3cret")
    end

    test "PRIVMSG NickServ :IDENTIFY account pwd → {:capture, :identify, pwd}" do
      assert {:capture, :identify, "s3cret"} =
               NSInterceptor.intercept("PRIVMSG NickServ :IDENTIFY vjt s3cret")
    end

    test "PRIVMSG NickServ :GHOST nick pwd → {:capture, :identify, pwd}" do
      assert {:capture, :identify, "s3cret"} =
               NSInterceptor.intercept("PRIVMSG NickServ :GHOST vjt s3cret")
    end

    test "PRIVMSG NickServ :REGISTER pwd email → {:capture, :register, pwd}" do
      assert {:capture, :register, "s3cret"} =
               NSInterceptor.intercept("PRIVMSG NickServ :REGISTER s3cret vjt@bad.ass")
    end

    test "case-insensitive verb match" do
      assert {:capture, :identify, "s3cret"} =
               NSInterceptor.intercept("privmsg nickserv :identify s3cret")
    end

    test "unrelated PRIVMSG → :passthrough" do
      assert :passthrough = NSInterceptor.intercept("PRIVMSG #italia :ciao")
    end

    test "PRIVMSG to non-NickServ → :passthrough" do
      assert :passthrough = NSInterceptor.intercept("PRIVMSG vjt :hello")
    end

    test "non-PRIVMSG → :passthrough" do
      assert :passthrough = NSInterceptor.intercept("JOIN #italia")
      assert :passthrough = NSInterceptor.intercept("PING :foo")
    end

    test "captures the ID alias (azzurra m_identify alias) — last token, :identify" do
      assert {:capture, :identify, "secret"} = NSInterceptor.intercept("PRIVMSG NickServ :ID secret")
      assert {:capture, :identify, "secret"} = NSInterceptor.intercept("PRIVMSG NickServ :id secret")
    end

    test "captures SIDENTIFY (silent identify) — last token, :identify" do
      assert {:capture, :identify, "secret"} =
               NSInterceptor.intercept("PRIVMSG NickServ :SIDENTIFY secret")
    end

    test "captures IDENTIFY/ID with an account argument — password is the last token" do
      assert {:capture, :identify, "secret"} =
               NSInterceptor.intercept("PRIVMSG NickServ :IDENTIFY myacct secret")

      assert {:capture, :identify, "secret"} =
               NSInterceptor.intercept("PRIVMSG NickServ :ID myacct secret")
    end

    test "captures a fully-qualified NickServ@services target" do
      assert {:capture, :identify, "secret"} =
               NSInterceptor.intercept("PRIVMSG NickServ@services.azzurra.chat :ID secret")
    end

    test "captures the NS / NICKSERV server-command form" do
      assert {:capture, :identify, "secret"} = NSInterceptor.intercept("NS IDENTIFY secret")
      assert {:capture, :identify, "secret"} = NSInterceptor.intercept("NS id secret")
      assert {:capture, :identify, "secret"} = NSInterceptor.intercept("NICKSERV SIDENTIFY secret")
    end

    test "captures bare IDENTIFY/ID/SIDENTIFY commands (m_identify, no PRIVMSG)" do
      assert {:capture, :identify, "secret"} = NSInterceptor.intercept("IDENTIFY secret")
      assert {:capture, :identify, "secret"} = NSInterceptor.intercept("ID secret")
      assert {:capture, :identify, "secret"} = NSInterceptor.intercept("SIDENTIFY myacct secret")
    end

    test "captures PASS post-connect identify (m_pass -> m_identify) — last token, :identify" do
      assert {:capture, :identify, "secret"} = NSInterceptor.intercept("PASS secret")
      assert {:capture, :identify, "secret"} = NSInterceptor.intercept("PASS mynick secret")
    end

    test "GHOST is :identify (last token); REGISTER is :register (first token)" do
      assert {:capture, :identify, "secret"} =
               NSInterceptor.intercept("PRIVMSG NickServ :GHOST oldnick secret")

      assert {:capture, :register, "secret"} =
               NSInterceptor.intercept("PRIVMSG NickServ :REGISTER secret me@x.io")
    end

    test "NS GHOST is :identify (last token); NS REGISTER is :register (first token)" do
      assert {:capture, :identify, "secret"} = NSInterceptor.intercept("NS GHOST oldnick secret")
      assert {:capture, :register, "secret"} = NSInterceptor.intercept("NS REGISTER secret me@x.io")
    end

    test "a verb-only identify line with no password is passthrough (no empty capture)" do
      assert :passthrough = NSInterceptor.intercept("IDENTIFY   ")
      assert :passthrough = NSInterceptor.intercept("PASS  ")
      assert :passthrough = NSInterceptor.intercept("PRIVMSG NickServ :ID  ")
    end

    test "ANCHORING: a channel message that merely contains identify/pass is passthrough" do
      assert :passthrough = NSInterceptor.intercept("PRIVMSG #chan :identify yourself please")
      assert :passthrough = NSInterceptor.intercept("PRIVMSG #chan :the pass is great")
      assert :passthrough = NSInterceptor.intercept("PRIVMSG NickServ :HELP IDENTIFY")
      assert :passthrough = NSInterceptor.intercept("ISON somenick")
      assert :passthrough = NSInterceptor.intercept("IDLE foo")
    end
  end

  # #131 — in-session NickServ SET PASSWD capture. Azzurra's `do_set` only
  # routes the `PASSWD` subcommand (`PASSWORD` errors); the new password is
  # the rest-of-line (Azzurra parses it with `strtok(NULL,"")`, so it may
  # carry spaces). The capture is a distinct `:set_passwd` kind because the
  # host commits it optimistically on-send — NOT on a `+r` rendezvous (a
  # SET PASSWD from an already-identified session emits no `+r`).
  describe "intercept/1 — SET PASSWD (#131)" do
    test "PRIVMSG NickServ :SET PASSWD newpass → {:capture, :set_passwd, newpass}" do
      assert {:capture, :set_passwd, "newpass"} =
               NSInterceptor.intercept("PRIVMSG NickServ :SET PASSWD newpass")
    end

    test "NS / NICKSERV SET PASSWD server-command form" do
      assert {:capture, :set_passwd, "newpass"} =
               NSInterceptor.intercept("NS SET PASSWD newpass")

      assert {:capture, :set_passwd, "newpass"} =
               NSInterceptor.intercept("NICKSERV SET PASSWD newpass")
    end

    test "bare SET PASSWD form (raw /quote)" do
      assert {:capture, :set_passwd, "newpass"} =
               NSInterceptor.intercept("SET PASSWD newpass")
    end

    test "password is the rest-of-line and may contain spaces (strtok(NULL,\"\"))" do
      assert {:capture, :set_passwd, "my new pass phrase"} =
               NSInterceptor.intercept("PRIVMSG NickServ :SET PASSWD my new pass phrase")

      assert {:capture, :set_passwd, "two words"} =
               NSInterceptor.intercept("NS SET PASSWD two words")
    end

    test "case-insensitive (cic forwards /ns set passwd verbatim, lower-cased)" do
      assert {:capture, :set_passwd, "newpass"} =
               NSInterceptor.intercept("privmsg nickserv :set passwd newpass")
    end

    test "fully-qualified NickServ@services target" do
      assert {:capture, :set_passwd, "newpass"} =
               NSInterceptor.intercept("PRIVMSG NickServ@services.azzurra.chat :SET PASSWD newpass")
    end

    test "SET PASSWORD is NOT matched — Azzurra verb is PASSWD, PASSWORD errors" do
      assert :passthrough = NSInterceptor.intercept("PRIVMSG NickServ :SET PASSWORD newpass")
      assert :passthrough = NSInterceptor.intercept("NS SET PASSWORD newpass")
      assert :passthrough = NSInterceptor.intercept("SET PASSWORD newpass")
    end

    test "other SET subcommands (EMAIL etc.) are passthrough — only PASSWD is captured" do
      assert :passthrough = NSInterceptor.intercept("PRIVMSG NickServ :SET EMAIL me@x.io")
      assert :passthrough = NSInterceptor.intercept("NS SET HIDE ON")
    end

    test "verb-only SET PASSWD with no new password is passthrough (no empty capture)" do
      assert :passthrough = NSInterceptor.intercept("PRIVMSG NickServ :SET PASSWD")
      assert :passthrough = NSInterceptor.intercept("PRIVMSG NickServ :SET PASSWD   ")
      assert :passthrough = NSInterceptor.intercept("SET PASSWD")
    end

    test "ANCHORING: a channel message / HELP that merely contains SET PASSWD is passthrough" do
      assert :passthrough = NSInterceptor.intercept("PRIVMSG #chan :SET PASSWD lol")
      assert :passthrough = NSInterceptor.intercept("PRIVMSG NickServ :HELP SET PASSWD")
    end
  end
end
