defmodule Grappa.Session.NSInterceptorTest do
  use ExUnit.Case, async: true

  alias Grappa.Session.NSInterceptor

  describe "intercept/1" do
    test "PRIVMSG NickServ :IDENTIFY pwd → {:capture, pwd}" do
      assert {:capture, "s3cret"} =
               NSInterceptor.intercept("PRIVMSG NickServ :IDENTIFY s3cret")
    end

    test "PRIVMSG NickServ :IDENTIFY account pwd → {:capture, pwd}" do
      assert {:capture, "s3cret"} =
               NSInterceptor.intercept("PRIVMSG NickServ :IDENTIFY vjt s3cret")
    end

    test "PRIVMSG NickServ :GHOST nick pwd → {:capture, pwd}" do
      assert {:capture, "s3cret"} =
               NSInterceptor.intercept("PRIVMSG NickServ :GHOST vjt s3cret")
    end

    test "PRIVMSG NickServ :REGISTER pwd email → {:capture, pwd}" do
      assert {:capture, "s3cret"} =
               NSInterceptor.intercept("PRIVMSG NickServ :REGISTER s3cret vjt@bad.ass")
    end

    test "case-insensitive verb match" do
      assert {:capture, "s3cret"} =
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
  end
end
