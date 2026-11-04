defmodule Grappa.PushReceiver do
  @moduledoc """
  The BROWSER side of a Web Push delivery, for tests that must read what
  the server actually sent: `Grappa.Push.WireFormatTest` (#1290, the wire
  format) and `Grappa.Session.InvitePushTest` (issue 2487, the payload a
  real dispatch built).

  The decryption is written out longhand from RFC 8188 §2 and RFC 8291
  §3.3 rather than calling `ExNudge.Encryption`. Reusing the production
  encryptor to check the production encryptor would pass for any pair of
  mutually-consistent implementations, including two that agree on a
  scheme no browser speaks. So this module plays the CLIENT: it holds a
  P-256 private key and an auth secret, is handed the POST body and
  nothing else, and must recover the plaintext.
  """
  use Boundary, top_level?: true, deps: [Grappa.Push, Grappa.PushFixtures]

  alias Grappa.{Push, PushFixtures}

  # RFC 8188 §2.1: salt(16) ‖ rs(4) ‖ idlen(1) ‖ keyid(idlen).
  @salt_length 16
  @auth_secret_length 16
  @gcm_tag_length 16

  @typedoc "The private half a browser keeps after `PushManager.subscribe()`."
  @type client :: %{public_key: binary(), private_key: binary(), auth_secret: binary()}

  @doc """
  Stands in for `PushManager.subscribe()`: generates a P-256 keypair and a
  16-byte auth secret, stores the PUBLIC half for `subject` at `endpoint`,
  and returns the subscription with the private half to decrypt with.

  The row goes in through `Grappa.PushFixtures.stored_subscription!/2`, not
  `Grappa.Push.create/2`: the receiving end is a `Bypass` on loopback over
  plain `http`, which the changeset refuses since #2401.
  """
  @spec browser_subscription(Grappa.Subject.t(), String.t()) :: {Push.Subscription.t(), client()}
  def browser_subscription(subject, endpoint) do
    {public_key, private_key} = :crypto.generate_key(:ecdh, :prime256v1)
    auth_secret = :crypto.strong_rand_bytes(@auth_secret_length)

    sub =
      PushFixtures.stored_subscription!(subject, %{
        endpoint: endpoint,
        p256dh_key: Base.url_encode64(public_key, padding: false),
        auth_key: Base.url_encode64(auth_secret, padding: false),
        user_agent: "Mozilla/5.0 push-receiver"
      })

    {sub, %{public_key: public_key, private_key: private_key, auth_secret: auth_secret}}
  end

  @doc """
  Decrypts one `aes128gcm` POST body with nothing but `client`'s key
  material. Returns the RFC 8188 header fields alongside the plaintext,
  which still carries its record padding (see `decode_payload/2`).
  """
  @spec decrypt_aes128gcm(binary(), client()) :: %{
          salt: binary(),
          record_size: non_neg_integer(),
          keyid: binary(),
          plaintext: binary()
        }
  def decrypt_aes128gcm(body, client) do
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

  @doc """
  Decrypts `body` and decodes the JSON payload the service worker would
  receive, string-keyed as the SW sees it.
  """
  @spec decode_payload(binary(), client()) :: map()
  def decode_payload(body, client) do
    body |> decrypt_aes128gcm(client) |> Map.fetch!(:plaintext) |> strip_padding() |> Jason.decode!()
  end

  defp hkdf_extract(salt, ikm), do: :crypto.mac(:hmac, :sha256, salt, ikm)

  defp hkdf_expand(prk, info, length) do
    :binary.part(:crypto.mac(:hmac, :sha256, prk, info <> <<1>>), 0, length)
  end

  # RFC 8188 §2 pads with 0x02 on the last record, 0x01 otherwise.
  defp strip_padding(plaintext) do
    plaintext |> String.trim_trailing(<<0>>) |> String.replace_suffix(<<0x02>>, "")
  end
end
