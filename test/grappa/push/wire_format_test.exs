defmodule Grappa.Push.WireFormatTest do
  @moduledoc """
  #1290 — pins the Web Push wire format so a dependency bump cannot
  walk it back to the pre-RFC drafts.

  Until 2026-08-14 we emitted draft-ietf-webpush-encryption-04
  `aesgcm`, which carries the salt and the server's ephemeral public
  key in the `encryption:` and `crypto-key:` HEADERS. Both are
  mandatory HKDF inputs, so any transport that does not preserve
  headers — UnifiedPush discards them by design — delivered a body
  the receiver structurally could not decrypt. RFC 8291 puts the same
  two values in the body's own RFC 8188 header block.

  ## The oracle is a receiver, not our own encryptor

  The decryption (`Grappa.PushReceiver`, shared with the issue 2487
  invite test) is written out longhand from RFC 8188 §2 and RFC 8291
  §3.3 rather than calling `ExNudge.Encryption`. Reusing the
  production encryptor to check the production encryptor would pass
  for any pair of mutually-consistent implementations, including two
  that agree on a scheme no browser speaks. The test therefore plays
  the CLIENT: it holds a P-256 private key and an auth secret, is
  handed the POST body and nothing else, and must recover the
  plaintext.

  That is also the closest measurement available here for the open
  subscription-survival question. It establishes that the material a
  browser already stored — the same `p256dh` + `auth` pair, unchanged
  by this switch — is SUFFICIENT to decrypt what we now send, with no
  header context. It does NOT establish that any particular browser,
  distributor or push service accepts it; that needs real devices and
  is explicitly out of reach from a test suite.

  `async: false` — `ExNudge.VAPID` reads the VAPID keypair from the
  `:ex_nudge` application environment at request time, and a sibling
  test mutates it.
  """
  use Grappa.DataCase, async: false

  import Grappa.AuthFixtures

  alias Grappa.{Push, PushReceiver}
  alias Grappa.Push.Sender

  @payload %{
    title: "vjt",
    body: "ping in #sbiffo",
    tag: "libera:#sbiffo",
    url: "/?network=libera&channel=%23sbiffo"
  }

  # RFC 8188 §2.1: salt(16) ‖ rs(4) ‖ idlen(1) ‖ keyid(idlen).
  @salt_length 16
  # An uncompressed P-256 point: 0x04 ‖ X(32) ‖ Y(32).
  @p256_point_length 65

  # Captures the request the Sender puts on the wire and hands it back
  # to the test process.
  defp capture_post(bypass) do
    test_pid = self()

    Bypass.expect_once(bypass, "POST", "/wp", fn conn ->
      {:ok, body, conn} = Plug.Conn.read_body(conn)
      send(test_pid, {:captured, conn.req_headers, body})
      Plug.Conn.resp(conn, 201, "")
    end)
  end

  defp header(headers, name) do
    case List.keyfind(headers, name, 0) do
      {^name, value} -> value
      nil -> nil
    end
  end

  describe "the POST a subscription receives" do
    setup do
      bypass = Bypass.open()
      capture_post(bypass)

      user = user_fixture()

      {sub, client} =
        PushReceiver.browser_subscription({:user, user.id}, "http://localhost:#{bypass.port}/wp")

      assert :ok = Sender.send_to_subscription(sub, @payload)
      assert_receive {:captured, headers, body}

      {:ok, headers: headers, body: body, client: client}
    end

    test "declares content-encoding: aes128gcm (RFC 8291 over RFC 8188)", %{headers: headers} do
      assert header(headers, "content-encoding") == "aes128gcm"

      # The capability `GET /api/config` publishes must name the coding
      # actually on the wire, or a client's check is a lie. Since #2401
      # the sender writes the header FROM this constant, so the literal
      # above is the pin and this line keeps the two from drifting apart.
      assert header(headers, "content-encoding") == Push.content_encoding()
    end

    test "carries NO aesgcm-draft headers", %{headers: headers} do
      # These two are precisely what a header-discarding transport drops,
      # and the reason the payload was undecryptable in the field.
      assert header(headers, "encryption") == nil
      assert header(headers, "crypto-key") == nil
    end

    test "authorizes with the RFC 8292 vapid scheme, not draft WebPush", %{headers: headers} do
      authorization = header(headers, "authorization")

      refute String.starts_with?(authorization, "WebPush ")

      # RFC 8292 §3. The whitespace after the comma is OWS per RFC 7235's
      # #auth-param list rule, so it is optional and NOT pinned here.
      assert %{"jwt" => jwt, "key" => key} =
               Regex.named_captures(
                 ~r/^vapid t=(?<jwt>[A-Za-z0-9_.-]+),\s*k=(?<key>[A-Za-z0-9_-]+)$/,
                 authorization
               )

      assert key == Push.vapid_public_key()

      # A push service verifies the JWT with the key from `k=` and
      # nothing else; so do we. The advertised point is uncompressed
      # (0x04 ‖ X ‖ Y), which is exactly a P-256 JWK's two coordinates.
      <<0x04, x::binary-size(32), y::binary-size(32)>> =
        Base.url_decode64!(key, padding: false)

      jwk =
        JOSE.JWK.from_map(%{
          "kty" => "EC",
          "crv" => "P-256",
          "x" => Base.url_encode64(x, padding: false),
          "y" => Base.url_encode64(y, padding: false)
        })

      assert {true, %JOSE.JWT{fields: claims}, _} = JOSE.JWT.verify_strict(jwk, ["ES256"], jwt)

      assert claims["aud"] == "http://localhost"
      assert claims["sub"] == "mailto:test@example.org"
      assert claims["exp"] > DateTime.to_unix(DateTime.utc_now())
    end

    test "body opens with the RFC 8188 header block: salt, rs, keyid", %{
      headers: headers,
      body: body,
      client: client
    } do
      decrypted = PushReceiver.decrypt_aes128gcm(body, client)

      assert byte_size(decrypted.salt) == @salt_length
      assert byte_size(decrypted.keyid) == @p256_point_length
      assert <<0x04, _::binary>> = decrypted.keyid
      assert decrypted.record_size >= byte_size(body)

      # The salt and the server key are IN the body, so they cannot also
      # be needed from headers — that is the whole structural fix.
      refute header(headers, "encryption")
      refute header(headers, "crypto-key")
    end

    test "decrypts with nothing but the subscription's own p256dh + auth", %{
      body: body,
      client: client
    } do
      # The measurement behind the subscription-survival question: the
      # key material a browser stored at subscribe time is enough, and
      # the body needs no header context to be read.
      assert PushReceiver.decode_payload(body, client) == %{
               "title" => @payload.title,
               "body" => @payload.body,
               "tag" => @payload.tag,
               "url" => @payload.url
             }
    end
  end
end
