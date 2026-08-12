defmodule Grappa.Uploads.ContentTypeTest do
  use ExUnit.Case, async: true

  alias Grappa.Uploads.ContentType

  describe "parse/1 — type/subtype" do
    test "a bare type is returned unchanged, with no charset" do
      assert ContentType.parse("text/plain") == {"text/plain", nil}
    end

    test "the parameter run is split off so the allowlist can match the type" do
      assert {"text/plain", _} = ContentType.parse("text/plain; charset=utf-8")
    end

    test "type is trimmed and ASCII-downcased so a lax client still matches" do
      assert {"text/plain", :utf8} = ContentType.parse(" TEXT/Plain ; Charset=UTF-8")
    end
  end

  describe "parse/1 — charset, closed set" do
    test "utf-8 is recognised" do
      assert {_, :utf8} = ContentType.parse("text/plain; charset=utf-8")
    end

    test "the undashed spelling is accepted as the same charset" do
      assert {_, :utf8} = ContentType.parse("text/plain; charset=utf8")
    end

    test "a quoted value is unquoted" do
      assert {_, :utf8} = ContentType.parse(~s|text/plain; charset="utf-8"|)
    end

    test "a charset we do not label with is dropped, not surfaced" do
      assert ContentType.parse("text/plain; charset=iso-8859-1") == {"text/plain", nil}
    end

    test "a non-charset parameter is ignored" do
      assert ContentType.parse("text/plain; format=flowed") == {"text/plain", nil}
    end

    test "charset is read past other parameters" do
      assert {_, :utf8} = ContentType.parse("text/plain; format=flowed; charset=utf-8")
    end

    test "a malformed parameter run does not raise" do
      assert ContentType.parse("text/plain;;;charset") == {"text/plain", nil}
    end

    test "charset is only read off a text type" do
      assert ContentType.parse("application/pdf; charset=utf-8") == {"application/pdf", nil}
      assert ContentType.parse("image/png; charset=utf-8") == {"image/png", nil}
    end
  end

  describe "header/2" do
    test "no charset → the bare MIME, byte for byte" do
      assert ContentType.header("text/plain", nil) == "text/plain"
    end

    test "a stored charset is re-spelled canonically" do
      assert ContentType.header("text/plain", :utf8) == "text/plain; charset=utf-8"
    end
  end

  describe "the client's parameter run never reaches the header" do
    # Once parameters are accepted, the declared type is client-
    # controlled text one hop from a response header, and `nosniff`
    # only pins the browser to what we declare. parse/1 must reduce it
    # to an atom, and header/2 must rebuild from that atom — so a
    # smuggled second type cannot ride through.
    test "a second type smuggled in the parameter run is dropped" do
      injected = ~s|text/plain; charset="utf-8"; x=1, text/html|
      {mime, charset} = ContentType.parse(injected)

      refute ContentType.header(mime, charset) =~ "text/html"
      assert ContentType.header(mime, charset) == "text/plain; charset=utf-8"
    end

    test "an unrecognised charset value is not echoed in the header" do
      {mime, charset} = ContentType.parse(~s|text/plain; charset=utf-8@evil|)

      assert ContentType.header(mime, charset) == "text/plain"
    end
  end

  describe "charsets/0" do
    test "every advertised charset round-trips through header/2" do
      for charset <- ContentType.charsets() do
        assert {_, ^charset} =
                 ContentType.parse(ContentType.header("text/plain", charset))
      end
    end
  end
end
