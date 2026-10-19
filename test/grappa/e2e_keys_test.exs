defmodule Grappa.E2eKeysTest do
  @moduledoc """
  issue 2430 — the key bundle grappa hosts for a subject on a network: the
  KEYS payloads its client built and signed, one per one-time key plus one
  for the fallback key, handed out by the session when a peer asks.

  grappa never reads a payload. Every test goes through the context.
  """
  use Grappa.DataCase, async: true

  import Grappa.AuthFixtures

  alias Grappa.E2eKeys
  alias Grappa.E2eKeys.Key

  # A KEYS payload as the agreed 2430 shape builds it: padded standard
  # base64 of JSON whose keys and signatures are unpadded base64.
  defp keys_payload(fallback?) do
    b64 = &Base.encode64(:crypto.strong_rand_bytes(&1), padding: false)
    id = ~s({"curve25519":"#{b64.(32)}","ed25519":"#{b64.(32)}","sig":"#{b64.(64)}"})
    Base.encode64(~s({"v":1,"id":#{id},"otk":{"key":"#{b64.(32)}","fallback":#{fallback?},"sig":"#{b64.(64)}"}}))
  end

  defp otks(n), do: for(_ <- 1..n, do: keys_payload(false))

  setup do
    user = user_fixture()
    {:ok, subject: {:user, user.id}, network: network_fixture()}
  end

  describe "upload/3 and status/2" do
    test "an empty bundle reads zero keys and no fallback", %{subject: subject, network: network} do
      assert E2eKeys.status(subject, network.id) == %{one_time_keys: 0, fallback: false}
    end

    test "one-time keys add up across uploads; the fallback key is replaced", %{subject: subject, network: network} do
      assert {:ok, %{one_time_keys: 3, fallback: true}} =
               E2eKeys.upload(subject, network.id, %{one_time_keys: otks(3), fallback: keys_payload(true)})

      second = keys_payload(true)

      assert {:ok, %{one_time_keys: 5, fallback: true}} =
               E2eKeys.upload(subject, network.id, %{one_time_keys: otks(2), fallback: second})

      # One fallback key, the latest: what is handed out once the one-time
      # keys run out.
      :ok = drain_otks(subject, network.id)
      assert {:ok, %Key{kind: :fallback, payload: ^second}} = E2eKeys.next(subject, network.id, :otk)
    end

    test "an upload without a fallback key keeps the one already there", %{subject: subject, network: network} do
      fallback = keys_payload(true)
      {:ok, _} = E2eKeys.upload(subject, network.id, %{one_time_keys: [], fallback: fallback})
      {:ok, _} = E2eKeys.upload(subject, network.id, %{one_time_keys: otks(1), fallback: nil})

      assert {:ok, %Key{kind: :fallback, payload: ^fallback}} = E2eKeys.next(subject, network.id, :fallback)
    end

    test "at most 50 one-time keys are held, and an upload past that is refused whole",
         %{subject: subject, network: network} do
      {:ok, %{one_time_keys: 48}} = E2eKeys.upload(subject, network.id, %{one_time_keys: otks(48), fallback: nil})

      assert {:error, :too_large} =
               E2eKeys.upload(subject, network.id, %{one_time_keys: otks(3), fallback: keys_payload(true)})

      # Nothing of the refused upload landed, its fallback key included.
      assert E2eKeys.status(subject, network.id) == %{one_time_keys: 48, fallback: false}
      assert {:ok, %{one_time_keys: 50}} = E2eKeys.upload(subject, network.id, %{one_time_keys: otks(2), fallback: nil})
    end

    test "refuses an empty upload, a payload that is not base64, and one past the size bound, whole",
         %{subject: subject, network: network} do
      assert {:error, :bad_request} = E2eKeys.upload(subject, network.id, %{one_time_keys: [], fallback: nil})

      assert {:error, :bad_request} =
               E2eKeys.upload(subject, network.id, %{one_time_keys: [keys_payload(false), "not base64!"], fallback: nil})

      too_big = String.duplicate("A", E2eKeys.max_payload_bytes() + 1)
      assert {:error, :bad_request} = E2eKeys.upload(subject, network.id, %{one_time_keys: [too_big], fallback: nil})
      assert {:error, :bad_request} = E2eKeys.upload(subject, network.id, %{one_time_keys: [], fallback: ""})

      assert E2eKeys.status(subject, network.id) == %{one_time_keys: 0, fallback: false}
    end

    test "a bundle belongs to one subject on one network", %{subject: subject, network: network} do
      {:ok, _} = E2eKeys.upload(subject, network.id, %{one_time_keys: otks(2), fallback: keys_payload(true)})

      visitor = visitor_fixture()
      assert E2eKeys.status({:user, user_fixture().id}, network.id) == %{one_time_keys: 0, fallback: false}
      assert E2eKeys.status({:visitor, visitor.id}, network.id) == %{one_time_keys: 0, fallback: false}
      assert E2eKeys.status(subject, network_fixture().id) == %{one_time_keys: 0, fallback: false}
      assert {:error, :empty} = E2eKeys.next({:visitor, visitor.id}, network.id, :otk)
    end

    test "a visitor holds a bundle of its own", %{network: network} do
      subject = {:visitor, visitor_fixture().id}

      assert {:ok, %{one_time_keys: 1, fallback: true}} =
               E2eKeys.upload(subject, network.id, %{one_time_keys: otks(1), fallback: keys_payload(true)})
    end
  end

  describe "next/3 and consume/1" do
    test "one-time keys go oldest first, each once; then the fallback key, again and again",
         %{subject: subject, network: network} do
      [first, second] = payloads = otks(2)
      fallback = keys_payload(true)
      {:ok, _} = E2eKeys.upload(subject, network.id, %{one_time_keys: payloads, fallback: fallback})

      assert {:ok, %Key{kind: :otk, payload: ^first} = key} = E2eKeys.next(subject, network.id, :otk)
      # Not consumed yet: asked again, the same key.
      assert {:ok, ^key} = E2eKeys.next(subject, network.id, :otk)
      assert :ok = E2eKeys.consume(key)
      assert {:error, :gone} = E2eKeys.consume(key)

      assert {:ok, %Key{payload: ^second} = key} = E2eKeys.next(subject, network.id, :otk)
      :ok = E2eKeys.consume(key)

      assert {:ok, %Key{kind: :fallback, payload: ^fallback} = key} = E2eKeys.next(subject, network.id, :otk)
      assert :ok = E2eKeys.consume(key)
      assert {:ok, %Key{kind: :fallback}} = E2eKeys.next(subject, network.id, :otk)
      assert E2eKeys.status(subject, network.id) == %{one_time_keys: 0, fallback: true}
    end

    test "asked for the fallback key, it never hands out a one-time key", %{subject: subject, network: network} do
      {:ok, _} = E2eKeys.upload(subject, network.id, %{one_time_keys: otks(1), fallback: nil})
      assert {:error, :empty} = E2eKeys.next(subject, network.id, :fallback)
      assert E2eKeys.status(subject, network.id) == %{one_time_keys: 1, fallback: false}
    end

    test "with nothing uploaded there is nothing to hand out", %{subject: subject, network: network} do
      assert {:error, :empty} = E2eKeys.next(subject, network.id, :otk)
    end
  end

  describe "clear/2" do
    test "drops the whole bundle of that subject on that network, and nothing else",
         %{subject: subject, network: network} do
      {:ok, _} = E2eKeys.upload(subject, network.id, %{one_time_keys: otks(2), fallback: keys_payload(true)})
      other = {:user, user_fixture().id}
      {:ok, _} = E2eKeys.upload(other, network.id, %{one_time_keys: otks(1), fallback: nil})
      {:ok, otk} = E2eKeys.next(subject, network.id, :otk)
      {:ok, fallback} = E2eKeys.next(subject, network.id, :fallback)

      assert :ok = E2eKeys.clear(subject, network.id)
      assert E2eKeys.status(subject, network.id) == %{one_time_keys: 0, fallback: false}
      assert E2eKeys.status(other, network.id) == %{one_time_keys: 1, fallback: false}
      # A key picked before the clear is not handed out after it, the
      # fallback key included: the client cleared it for a reason.
      assert {:error, :gone} = E2eKeys.consume(otk)
      assert {:error, :gone} = E2eKeys.consume(fallback)
    end
  end

  defp drain_otks(subject, network_id) do
    case E2eKeys.next(subject, network_id, :otk) do
      {:ok, %Key{kind: :otk} = key} ->
        :ok = E2eKeys.consume(key)
        drain_otks(subject, network_id)

      _ ->
        :ok
    end
  end
end
