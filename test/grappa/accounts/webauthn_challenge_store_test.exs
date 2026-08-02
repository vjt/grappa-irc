defmodule Grappa.Accounts.WebAuthnChallengeStoreTest do
  use ExUnit.Case, async: false

  alias Grappa.Accounts.WebAuthnChallengeStore

  test "challenge is consumed exactly once and purpose-bound" do
    challenge = Wax.new_registration_challenge(origin: "https://irc.example", rp_id: "irc.example")
    id = WebAuthnChallengeStore.put(challenge, :registration, %{user_id: "user-1"})

    assert {:error, :invalid_challenge} = WebAuthnChallengeStore.take(id, :authentication)
    assert {:error, :invalid_challenge} = WebAuthnChallengeStore.take(id, :registration)

    second = WebAuthnChallengeStore.put(challenge, :registration, %{user_id: "user-1"})
    assert {:ok, ^challenge, %{user_id: "user-1"}} = WebAuthnChallengeStore.take(second, :registration)
    assert {:error, :invalid_challenge} = WebAuthnChallengeStore.take(second, :registration)
  end
end
