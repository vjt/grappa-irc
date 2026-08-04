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

  test "a challenge at or past its TTL is refused, and refusing it consumes it" do
    challenge = Wax.new_registration_challenge(origin: "https://irc.example", rp_id: "irc.example")
    id = WebAuthnChallengeStore.put(challenge, :registration, %{user_id: "user-1"})

    # Sampled AFTER the put, so `now + ttl` is at or past the stored
    # `expires_at` whichever side of a second tick the put landed on.
    now = System.monotonic_time(:second)
    ttl = WebAuthnChallengeStore.ttl_seconds()

    assert {:ok, ^challenge, %{user_id: "user-1"}} =
             WebAuthnChallengeStore.take(id, :registration, now)

    expired = WebAuthnChallengeStore.put(challenge, :registration, %{user_id: "user-2"})

    assert {:error, :invalid_challenge} =
             WebAuthnChallengeStore.take(expired, :registration, now + ttl)

    # A refusal must EVICT, not merely decline: an expired ceremony that
    # stayed in the map would answer a later in-window take.
    assert {:error, :invalid_challenge} = WebAuthnChallengeStore.take(expired, :registration)
  end

  test "the sweep drops an abandoned ceremony and keeps a live one" do
    # An abandoned ceremony is never taken, so the read-path TTL check
    # never sees it — driving the callback directly is what proves the
    # sweep, and needs no control over the monotonic clock.
    now = System.monotonic_time(:second)
    challenge = Wax.new_registration_challenge(origin: "https://irc.example", rp_id: "irc.example")

    state = %{
      "abandoned" => {challenge, :registration, %{}, now - 1},
      "live" => {challenge, :registration, %{}, now + 300}
    }

    assert {:noreply, swept} = WebAuthnChallengeStore.handle_info(:sweep, state)
    assert Map.keys(swept) == ["live"]
  end
end
