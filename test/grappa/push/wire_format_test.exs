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

  The decryption below is written out longhand from RFC 8188 §2 and
  RFC 8291 §3.3 rather than calling `ExNudge.Encryption`. Reusing the
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

  import Grappa.PushFixtures, only: [stored_subscription!: 2]

  import Grappa.AuthFixtures

  alias Grappa.Push
  alias Grappa.Push.Sender

  @payload %{
    title: "vjt",
    body: "ping in #sbiffo",
    tag: "libera:#sbiffo",
    url: "/?network=libera&channel=%23sbiffo"
  }

  # RFC 8188 §2.1: salt(16) ‖ rs(4) ‖ idlen(1) ‖ keyid(idlen).
  @salt_length 16
  @auth_secret_length 16
  @gcm_tag_length 16
  # An uncompressed P-256 point: 0x04 ‖ X(32) ‖ Y(32).
  @p256_point_length 65

  # Stands in for `PushManager.subscribe()`: the client generates a
  # P-256 keypair and a 16-byte auth secret, ships the PUBLIC half to
  # the server, and keeps the private half to decrypt with.
  defp browser_subscription(subject, endpoint) do
    {public_key, private_key} = :crypto.generate_key(:ecdh, :prime256v1)
    auth_secret = :crypto.strong_rand_bytes(@auth_secret_length)

    sub =
      stored_subscription!(subject, %{
        endpoint: endpoint,
        p256dh_key: Base.url_encode64(public_key, padding: false),
        auth_key: Base.url_encode64(auth_secret, padding: false),
        user_agent: "Mozilla/5.0 wire-format-test"
      })

    {sub, %{public_key: public_key, private_key: private_key, auth_secret: auth_secret}}
  end

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

  # --- RFC 8291 receiver, longhand ------------------------------------

  defp hkdf_extract(salt, ikm), do: :crypto.mac(:hmac, :sha256, salt, ikm)

  defp hkdf_expand(prk, info, length) do
    :binary.part(:crypto.mac(:hmac, :sha256, prk, info <> <<1>>), 0, length)
  end

  defp decrypt_aes128gcm(body, client) do
    # RFC 8188 §2.1 header block, then the single record.
    <<salt::binary-size(@salt_length), record_size::unsigned-big-integer-size(32), idlen::8, rest::binary>> = body

    <<server_public_key::binary-size(idlen), record::binary>> = rest
    ciphertext_length = byte_size(record) - @gcm_tag_length
    <<ciphertext::binary-size(ciphertext_length), tag::binary-size(@gcm_tag_length)>> = record

    # RFC 8291 §3.3 — the shared secret and the IKM derivation.
    shared_secret =
      :crypto.compute_key(:ecdh, server_public_key, client.private_key, :prime256v1)

    key_info = "WebPush: info" <> <<0>> <> client.public_key <> server_public_key
    ikm = hkdf_expand(hkdf_extract(client.auth_secret, shared_secret), key_info, 32)

    prk = hkdf_extract(salt, ikm)
    cek = hkdf_expand(prk, "Content-Encoding: aes128gcm" <> <<0>>, 16)
    nonce = hkdf_expand(prk, "Content-Encoding: nonce" <> <<0>>, 12)

    plaintext =
      :crypto.crypto_one_time_aead(:aes_128_gcm, cek, nonce, ciphertext, <<>>, tag, false)

    %{
      salt: salt,
      record_size: record_size,
      keyid: server_public_key,
      plaintext: plaintext
    }
  end

  # RFC 8188 §2 pads with 0x02 on the last record, 0x01 otherwise.
  defp strip_padding(plaintext) do
    plaintext |> String.trim_trailing(<<0>>) |> String.replace_suffix(<<0x02>>, "")
  end

  describe "the POST a subscription receives" do
    setup do
      bypass = Bypass.open()
      capture_post(bypass)

      user = user_fixture()

      {sub, client} =
        browser_subscription({:user, user.id}, "http://localhost:#{bypass.port}/wp")

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
      decrypted = decrypt_aes128gcm(body, client)

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
      decrypted = decrypt_aes128gcm(body, client)

      assert Jason.decode!(strip_padding(decrypted.plaintext)) == %{
               "title" => @payload.title,
               "body" => @payload.body,
               "tag" => @payload.tag,
               "url" => @payload.url
             }
    end
  end
end
