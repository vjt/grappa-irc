defmodule Grappa.Networks.LastJoinedChannelsTest do
  @moduledoc """
  CP22 cluster B (channel-client-polish #14, B-restart) — tests for the
  `last_joined_channels` runtime snapshot persisted by `Session.Server`
  on every self-JOIN/PART/KICK.

  Two surfaces under test:
    1. `Credentials.update_last_joined_channels/3` — id-keyed write
       used by Session.Server's persister callback. Returns `:ok` /
       `{:error, :not_found}` / `{:error, changeset}`.
    2. `SessionPlan.build_plan/4` — the boot-time merge of
       `autojoin_channels` (operator config) + `last_joined_channels`
       (runtime snapshot). Order: operator first, then snapshot
       extras. Dedupe is RFC 2812 §2.2 case-insensitive on channel
       names.

  Async-safe: each test sets up a unique user/network pair via
  fixtures, so the Repo sandbox isolation holds.
  """
  use Grappa.DataCase, async: true

  use ExUnitProperties

  import Grappa.AuthFixtures

  alias Grappa.Networks.{Credential, Credentials, SessionPlan}
  alias Grappa.Repo

  defp setup_credential(attrs \\ %{}) do
    user = user_fixture(name: "vjt-#{System.unique_integer([:positive])}")

    {network, _} =
      network_with_server(port: 6667, slug: "test-#{System.unique_integer([:positive])}")

    cred = credential_fixture(user, network, attrs)
    {user, network, cred}
  end

  defp reload(%Credential{} = cred) do
    Repo.get_by!(Credential, user_id: cred.user_id, network_id: cred.network_id)
  end

  describe "Credentials.update_last_joined_channels/3" do
    test "writes the channels list and round-trips on read" do
      {_, _, cred} = setup_credential()
      assert cred.last_joined_channels == []

      assert :ok =
               Credentials.update_last_joined_channels(
                 cred.user_id,
                 cred.network_id,
                 ["#bofh", "#grappa", "#italia"]
               )

      reloaded = reload(cred)
      assert reloaded.last_joined_channels == ["#bofh", "#grappa", "#italia"]
    end

    # S34 (2026-07-08 review) — routed through the NARROW
    # `Credential.last_joined_channels_changeset/2` instead of the wide
    # `changeset/2`. This asserts the narrow path still canonicalises
    # channel names (UX-4 bucket A) exactly as the wide path did — the
    # persisted values must be byte-identical, not just the cap behaviour.
    test "canonicalises mixed-case channel names (narrow-changeset parity)" do
      {_, _, cred} = setup_credential()

      assert :ok =
               Credentials.update_last_joined_channels(
                 cred.user_id,
                 cred.network_id,
                 ["#Sniffo", "#BOFH"]
               )

      assert reload(cred).last_joined_channels == ["#sniffo", "#bofh"]
    end

    test "overwrites prior snapshot on each call (latest write wins)" do
      {_, _, cred} = setup_credential()

      assert :ok = Credentials.update_last_joined_channels(cred.user_id, cred.network_id, ["#a"])
      assert reload(cred).last_joined_channels == ["#a"]

      assert :ok =
               Credentials.update_last_joined_channels(cred.user_id, cred.network_id, ["#b", "#c"])

      assert reload(cred).last_joined_channels == ["#b", "#c"]
    end

    test "empty list shrinks the snapshot to zero" do
      {_, _, cred} = setup_credential()

      assert :ok =
               Credentials.update_last_joined_channels(cred.user_id, cred.network_id, ["#a", "#b"])

      assert :ok = Credentials.update_last_joined_channels(cred.user_id, cred.network_id, [])
      assert reload(cred).last_joined_channels == []
    end

    test "{:error, :not_found} for unknown (user, network)" do
      assert {:error, :not_found} =
               Credentials.update_last_joined_channels(
                 Ecto.UUID.generate(),
                 999_999,
                 ["#x"]
               )
    end

    # CP24 cluster post-cr-review bucket B, persistence/S8 — cap.
    #
    # `last_joined_channels` is the snapshot of currently-joined channels
    # (Session.Server's sorted-keyset diff source), so the natural upper
    # bound is the live join count (typically 5-50, RFC 2812 has no
    # absolute ceiling). The cap is a safety belt: if a pathological
    # bouncer ever holds >200 joined channels, the JSON column write +
    # boot-time merge stay bounded — we drop the tail (the snapshot is
    # already sorted, so "oldest by sort key" == "tail").
    test "caps at 200 entries (tail dropped) on oversize input" do
      {_, _, cred} = setup_credential()

      oversize =
        for n <- 1..250, do: "#chan-" <> String.pad_leading(Integer.to_string(n), 3, "0")

      assert :ok =
               Credentials.update_last_joined_channels(
                 cred.user_id,
                 cred.network_id,
                 oversize
               )

      reloaded = reload(cred)
      assert length(reloaded.last_joined_channels) == 200
      # Head retained, tail dropped — the input was already sorted by name,
      # so the tail = lexicographically latest entries.
      assert hd(reloaded.last_joined_channels) == "#chan-001"
      assert List.last(reloaded.last_joined_channels) == "#chan-200"
      refute "#chan-201" in reloaded.last_joined_channels
    end

    test "200-entry input round-trips unchanged (boundary)" do
      {_, _, cred} = setup_credential()
      exactly = for n <- 1..200, do: "##{n}"

      assert :ok =
               Credentials.update_last_joined_channels(cred.user_id, cred.network_id, exactly)

      assert reload(cred).last_joined_channels == exactly
    end

    property "result length never exceeds 200 regardless of input size" do
      {_, _, cred} = setup_credential()

      check all(input <- StreamData.list_of(channel_name(), max_length: 400), max_runs: 25) do
        :ok = Credentials.update_last_joined_channels(cred.user_id, cred.network_id, input)
        reloaded = reload(cred)
        assert length(reloaded.last_joined_channels) <= 200
        # Cap preserves head order, only tail drops.
        assert reloaded.last_joined_channels == Enum.take(input, 200)
      end
    end
  end

  describe "Credential.changeset/2 schema-level cap (H15, REV-D)" do
    # H15: defensive schema-level cap. The context helper
    # `update_last_joined_channels/3` truncates before building the
    # changeset, but any bypassing writer (future REST surface,
    # operator mix task, test helper) MUST also observe the bound.
    # `validate_length(:last_joined_channels, max: 200)` is the
    # belt-and-braces guard.
    test "rejects oversize list at the changeset boundary (bypassing the context helper)" do
      {_, _, cred} = setup_credential()

      oversize =
        for n <- 1..250, do: "#chan-" <> String.pad_leading(Integer.to_string(n), 3, "0")

      cs = Credential.changeset(cred, %{last_joined_channels: oversize})

      refute cs.valid?

      errors =
        Ecto.Changeset.traverse_errors(cs, fn {msg, opts} ->
          Regex.replace(~r"%{(\w+)}", msg, fn _, key ->
            opts |> Keyword.get(String.to_existing_atom(key), key) |> to_string()
          end)
        end)

      assert List.first(errors[:last_joined_channels]) =~ "should have at most"
    end

    test "accepts exactly the cap length at the changeset boundary (boundary)" do
      {_, _, cred} = setup_credential()
      exactly = for n <- 1..Credential.last_joined_channels_max(), do: "##{n}"

      cs = Credential.changeset(cred, %{last_joined_channels: exactly})
      assert cs.valid?
    end

    test "last_joined_channels_max/0 exposes the schema-level constant" do
      assert Credential.last_joined_channels_max() == 200
    end
  end

  describe "SessionPlan.build_plan boot-merge — autojoin + last_joined" do
    test "merges autojoin_channels + last_joined_channels at session_plan build" do
      {_, _, cred} =
        setup_credential(%{autojoin_channels: ["#bofh", "#grappa"]})

      assert :ok =
               Credentials.update_last_joined_channels(
                 cred.user_id,
                 cred.network_id,
                 ["#italia", "#linux"]
               )

      reloaded = reload(cred)

      # Direct call into the helper to verify dedupe + order. The full
      # `SessionPlan.resolve/1` path requires DNS/Server fixtures; the
      # dedupe rule is the load-bearing logic for restart-rehydrate.
      merged =
        do_merge(reloaded.autojoin_channels, reloaded.last_joined_channels)

      assert merged == ["#bofh", "#grappa", "#italia", "#linux"]
    end

    test "dedupes case-insensitively (RFC 2812 §2.2)" do
      autojoin = ["#BOFH"]
      last_joined = ["#bofh", "#grappa"]

      merged = do_merge(autojoin, last_joined)

      # Operator case wins; #grappa from snapshot is appended.
      assert merged == ["#BOFH", "#grappa"]
    end

    test "dedupes rfc1459 bracket variants (#364 — bahamut casemapping)" do
      # `#foo[1]` and `#foo{1}` are ONE channel to bahamut (rfc1459 folds
      # [ -> {). The old String.downcase dedup left them distinct, forking
      # the snapshot into a duplicate autojoin. The merge must fold via
      # canonical_channel/1 so the snapshot variant is recognised as
      # already covered by the operator entry (whose case wins).
      autojoin = ["#foo[1]"]
      last_joined = ["#foo{1}", "#grappa"]

      merged = do_merge(autojoin, last_joined)

      assert merged == ["#foo[1]", "#grappa"]
    end

    test "empty last_joined → just operator config" do
      assert do_merge(["#a", "#b"], []) == ["#a", "#b"]
    end

    test "empty autojoin → just snapshot" do
      assert do_merge([], ["#x", "#y"]) == ["#x", "#y"]
    end

    test "preserves order — operator entries first, snapshot extras after" do
      autojoin = ["#z", "#a"]
      last_joined = ["#m", "#a"]

      assert do_merge(autojoin, last_joined) == ["#z", "#a", "#m"]
    end
  end

  defp do_merge(autojoin, last_joined) do
    apply(SessionPlan, :__merge_autojoin_for_test__, [autojoin, last_joined])
  rescue
    UndefinedFunctionError ->
      flunk("SessionPlan.__merge_autojoin_for_test__/2 missing — expose the merge_autojoin/2 helper for testing")
  end

  # StreamData generator for syntactically-valid IRC channel names.
  # Keeps the property test focused on the cap, not on changeset
  # validation rejections from the channel-name regex.
  defp channel_name do
    StreamData.bind(StreamData.string(?a..?z, min_length: 1, max_length: 12), fn s ->
      StreamData.constant("#" <> s)
    end)
  end
end
