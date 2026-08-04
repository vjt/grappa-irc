defmodule Grappa.Accounts.WebAuthnVerificationTest do
  @moduledoc """
  The verification half of the passkey door: `Wax.register/3` and
  `Wax.authenticate/5`, driven by a real signed ceremony (#742).

  Before this, nothing in the suite reached either function. Every other
  passkey test seeds a `Passkey` row directly or exercises a route that
  never verifies an assertion, so deleting the signature check — or
  reordering `authenticate/3` so a forged blob short-circuits — left the
  whole suite green while any assertion logged anyone in.
  """
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.Accounts.{Passkey, WebAuthn}
  alias Grappa.{Repo, WebAuthnCeremony}

  @origin "https://irc.example"
  @binding %{ip: "192.0.2.1", client_id: "client"}

  setup do
    {user, password} = user_fixture_with_password()
    authenticator = WebAuthnCeremony.new_authenticator(<<7, 7, 7, 7>>)

    %{user: user, password: password, authenticator: authenticator}
  end

  describe "registration verification" do
    test "a ceremony this authenticator signed registers the credential", ctx do
      params = register_params(ctx)

      assert {:ok, %Passkey{} = passkey} =
               WebAuthn.complete_registration(ctx.user, params, @binding)

      assert passkey.credential_id == ctx.authenticator.credential_id
      assert passkey.user_id == ctx.user.id

      # The stored key must survive the CBOR round trip as the coordinates
      # Wax handed over — an assertion later verifies against exactly this.
      assert {:ok, stored, ""} = CBOR.decode(passkey.public_key)
      assert stored[-2] == ctx.authenticator.x
      assert stored[-3] == ctx.authenticator.y
    end

    # `attestation: "none"` carries no attestation signature, so the evil
    # twin cannot be a mutated one — there is nothing to mutate. What the
    # server still verifies is that the ceremony answers THIS challenge at
    # THIS origin, so those are the ones worth forging.
    test "a ceremony answering a different challenge is refused", ctx do
      {challenge_id, _} = begin_registration(ctx)
      {_, other_challenge} = begin_registration(ctx)

      params =
        WebAuthnCeremony.registration_params(
          ctx.authenticator,
          challenge_id,
          other_challenge,
          @origin
        )

      assert {:error, :invalid_passkey} =
               WebAuthn.complete_registration(ctx.user, params, @binding)

      assert Repo.aggregate(Passkey, :count, :id) == 0
    end

    test "a ceremony signed for another origin is refused", ctx do
      {challenge_id, challenge} = begin_registration(ctx)

      params =
        WebAuthnCeremony.registration_params(
          ctx.authenticator,
          challenge_id,
          challenge,
          "https://phish.example"
        )

      assert {:error, :invalid_passkey} =
               WebAuthn.complete_registration(ctx.user, params, @binding)

      assert Repo.aggregate(Passkey, :count, :id) == 0
    end

    test "a ceremony bound to someone else's account is refused", ctx do
      params = register_params(ctx)
      intruder = user_fixture()

      assert {:error, :invalid_passkey} =
               WebAuthn.complete_registration(intruder, params, @binding)

      assert Repo.aggregate(Passkey, :count, :id) == 0
    end
  end

  describe "assertion verification" do
    setup ctx do
      assert {:ok, passkey} =
               WebAuthn.complete_registration(ctx.user, register_params(ctx), @binding)

      Map.put(ctx, :passkey, passkey)
    end

    test "an assertion this authenticator signed authenticates the user", ctx do
      params = assert_params(ctx, 1)

      assert {:ok, authenticated, %{}} = WebAuthn.authenticate(params, :second_factor, @binding)
      assert authenticated.id == ctx.user.id
      assert Repo.get!(Passkey, ctx.passkey.id).sign_count == 1
    end

    # THE test this whole fixture exists for. One bit of the signature is
    # flipped and nothing else changes, so the only rule that can refuse it
    # is the signature check itself. If this goes green with the
    # verification removed, the door is open to any blob.
    test "an assertion with a mutated signature is refused", ctx do
      params = WebAuthnCeremony.tamper_signature(assert_params(ctx, 1))

      assert {:error, :invalid_passkey} = WebAuthn.authenticate(params, :second_factor, @binding)
      assert Repo.get!(Passkey, ctx.passkey.id).sign_count == 0
    end

    test "an assertion signed by a different authenticator is refused", ctx do
      impostor = WebAuthnCeremony.new_authenticator(ctx.authenticator.credential_id)
      {challenge_id, challenge} = begin_authentication(ctx)

      params =
        WebAuthnCeremony.assertion_params(impostor, challenge_id, challenge, @origin, 1)

      assert {:error, :invalid_passkey} = WebAuthn.authenticate(params, :second_factor, @binding)
      assert Repo.get!(Passkey, ctx.passkey.id).sign_count == 0
    end

    test "an assertion signed for another origin is refused", ctx do
      {challenge_id, challenge} = begin_authentication(ctx)

      params =
        WebAuthnCeremony.assertion_params(
          ctx.authenticator,
          challenge_id,
          challenge,
          "https://phish.example",
          1
        )

      assert {:error, :invalid_passkey} = WebAuthn.authenticate(params, :second_factor, @binding)
    end

    # The challenge is one-shot, so a captured assertion cannot be sent
    # twice even though its signature stays perfectly valid.
    test "a valid assertion cannot be replayed", ctx do
      params = assert_params(ctx, 1)

      assert {:ok, _, _} = WebAuthn.authenticate(params, :second_factor, @binding)
      assert {:error, :invalid_passkey} = WebAuthn.authenticate(params, :second_factor, @binding)
    end

    # A ceremony opened for one purpose must not be spendable on another:
    # the purpose is what tells a mode change from a login.
    test "an assertion opened for a mode change cannot be spent as a login", ctx do
      {:ok, %{challenge_id: id, public_key: %{challenge: challenge}}} =
        WebAuthn.begin_authentication(ctx.user, :mode_change, @binding, @origin, %{mode: :disabled})

      params = WebAuthnCeremony.assertion_params(ctx.authenticator, id, challenge, @origin, 1)

      assert {:error, :invalid_passkey} = WebAuthn.authenticate(params, :passwordless, @binding)
    end

    test "an assertion whose counter did not advance is refused as a clone", ctx do
      assert {:ok, _, _} = WebAuthn.authenticate(assert_params(ctx, 5), :second_factor, @binding)

      assert {:error, :invalid_passkey} =
               WebAuthn.authenticate(assert_params(ctx, 5), :second_factor, @binding)

      assert Repo.get!(Passkey, ctx.passkey.id).sign_count == 5
    end
  end

  defp begin_registration(ctx) do
    {:ok, %{challenge_id: id, public_key: %{challenge: challenge}}} =
      WebAuthn.begin_registration(ctx.user, ctx.password, "phone", @binding, @origin)

    {id, challenge}
  end

  defp begin_authentication(ctx) do
    {:ok, %{challenge_id: id, public_key: %{challenge: challenge}}} =
      WebAuthn.begin_authentication(ctx.user, :second_factor, @binding, @origin, %{})

    {id, challenge}
  end

  defp register_params(ctx) do
    {id, challenge} = begin_registration(ctx)
    WebAuthnCeremony.registration_params(ctx.authenticator, id, challenge, @origin)
  end

  defp assert_params(ctx, sign_count) do
    {id, challenge} = begin_authentication(ctx)
    WebAuthnCeremony.assertion_params(ctx.authenticator, id, challenge, @origin, sign_count)
  end
end
