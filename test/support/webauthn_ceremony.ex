defmodule Grappa.WebAuthnCeremony do
  @moduledoc """
  A software authenticator that produces WebAuthn ceremonies `Wax` accepts.

  ## Why this is support infrastructure and not a helper in one test file

  `Wax.register/3` and `Wax.authenticate/5` are the only things standing
  between a POSTed blob and a logged-in session, and nothing could reach
  them from a test: every passkey test either seeds a `Passkey` row
  directly or drives a route that never verifies an assertion (#742). A
  ceremony cannot be faked with a fixture blob either — the signature is
  over bytes that include the challenge the server just minted, so it has
  to be produced per test, from a real key.

  So this signs for real. `new_authenticator/1` generates a P-256 key
  pair the way an authenticator would; `registration_params/4` and
  `assertion_params/5` assemble exactly the four fields
  `Grappa.Accounts.WebAuthn` reads off the wire, base64url-encoded
  without padding like the browser sends them.

  ## Every ceremony owes an evil twin

  A happy-path-only test here is the very hole #742 describes: it stays
  green if the verification is deleted. `tamper_signature/1` returns the
  same ceremony with one bit of the signature flipped — everything else
  byte-identical — so the only thing that can make the assertion fail is
  the signature check itself.

  ## Faithful where it matters

  The COSE key inside the attestation is CBOR-encoded as byte strings
  (`%CBOR.Tag{tag: :bytes}`), which is what a real authenticator emits
  and what `Wax.Utils.CBOR` unwraps. Flags carry UP and UV because
  `challenge_opts/1` asks for `user_verification: "required"`, and AT on
  registration because that is what carries the credential.
  """

  import Bitwise

  @aaguid <<0::128>>

  @up 0x01
  @uv 0x04
  @at 0x40

  @type t :: %{
          credential_id: binary(),
          x: binary(),
          y: binary(),
          private_key: binary()
        }

  @doc """
  Generates an authenticator holding one P-256 credential.

  `credential_id` is the opaque handle the server stores and the client
  echoes back as `raw_id`; tests pass their own so two authenticators in
  one test stay tellable apart.
  """
  @spec new_authenticator(binary()) :: t()
  def new_authenticator(credential_id) when is_binary(credential_id) do
    {<<4, x::binary-size(32), y::binary-size(32)>>, private_key} =
      :crypto.generate_key(:ecdh, :prime256v1)

    %{credential_id: credential_id, x: x, y: y, private_key: private_key}
  end

  @doc """
  The COSE key for this authenticator, in the shape
  `Grappa.Accounts.Passkey` stores.

  For tests that seed a credential row directly instead of registering
  one through a ceremony.
  """
  @spec cose_key(t()) :: map()
  def cose_key(%{x: x, y: y}), do: %{1 => 2, 3 => -7, -1 => 1, -2 => x, -3 => y}

  @doc """
  Registration ceremony for `challenge_b64` (the value
  `begin_registration/5` published), as `complete_registration/3` reads it.
  """
  @spec registration_params(t(), String.t(), String.t(), String.t()) :: map()
  def registration_params(authenticator, challenge_id, challenge_b64, origin) do
    client_data = client_data_json("webauthn.create", challenge_b64, origin)

    auth_data =
      authenticator_data(origin, @up ||| @uv ||| @at, 0) <>
        @aaguid <>
        <<byte_size(authenticator.credential_id)::unsigned-big-integer-size(16)>> <>
        authenticator.credential_id <>
        cbor_cose_key(authenticator)

    attestation =
      CBOR.encode(%{
        "fmt" => "none",
        "attStmt" => %{},
        "authData" => %CBOR.Tag{tag: :bytes, value: auth_data}
      })

    %{
      "challenge_id" => challenge_id,
      "attestation_object" => encode(attestation),
      "client_data_json" => encode(client_data),
      "transports" => ["internal"]
    }
  end

  @doc """
  Assertion ceremony for `challenge_b64` (the value `begin_authentication/5`
  published), as `authenticate/3` reads it.

  `sign_count` is what the authenticator claims, so a test can drive the
  clone-detection rule as well as the signature check.
  """
  @spec assertion_params(t(), String.t(), String.t(), String.t(), non_neg_integer()) :: map()
  def assertion_params(authenticator, challenge_id, challenge_b64, origin, sign_count) do
    client_data = client_data_json("webauthn.get", challenge_b64, origin)
    auth_data = authenticator_data(origin, @up ||| @uv, sign_count)

    signature =
      :crypto.sign(
        :ecdsa,
        :sha256,
        auth_data <> :crypto.hash(:sha256, client_data),
        [authenticator.private_key, :prime256v1]
      )

    %{
      "challenge_id" => challenge_id,
      "raw_id" => encode(authenticator.credential_id),
      "authenticator_data" => encode(auth_data),
      "signature" => encode(signature),
      "client_data_json" => encode(client_data)
    }
  end

  @doc """
  The same ceremony with one bit of the signature flipped.

  Everything else stays byte-identical, so an assertion that still passes
  proves the signature is not being checked.
  """
  @spec tamper_signature(map()) :: map()
  def tamper_signature(%{"signature" => signature} = params) do
    <<head::binary-size(byte_size(signature) - 1), last>> = signature
    Map.put(params, "signature", head <> <<bxor(last, 1)>>)
  end

  defp authenticator_data(origin, flags, sign_count) do
    rp_id = URI.parse(origin).host

    :crypto.hash(:sha256, rp_id) <> <<flags>> <> <<sign_count::unsigned-big-integer-size(32)>>
  end

  defp client_data_json(type, challenge_b64, origin) do
    Jason.encode!(%{type: type, challenge: challenge_b64, origin: origin})
  end

  defp cbor_cose_key(%{x: x, y: y}) do
    CBOR.encode(%{
      1 => 2,
      3 => -7,
      -1 => 1,
      -2 => %CBOR.Tag{tag: :bytes, value: x},
      -3 => %CBOR.Tag{tag: :bytes, value: y}
    })
  end

  defp encode(binary), do: Base.url_encode64(binary, padding: false)
end
