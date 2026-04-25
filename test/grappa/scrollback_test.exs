defmodule Grappa.ScrollbackTest do
  use Grappa.DataCase, async: true

  alias Grappa.Scrollback
  alias Grappa.Scrollback.Message

  defp sample(i), do: sample(i, %{})

  defp sample(i, overrides) do
    Map.merge(
      %{
        network_id: "azzurra",
        channel: "#sniffo",
        server_time: i,
        kind: "privmsg",
        sender: "vjt",
        body: "msg #{i}"
      },
      overrides
    )
  end

  describe "insert/1" do
    test "persists a valid message and returns the schema struct" do
      assert {:ok, %Message{} = m} = Scrollback.insert(sample(0))
      assert m.body == "msg 0"
      assert m.kind == :privmsg
      assert is_integer(m.id)
    end

    test "rejects invalid kind via Ecto.Enum cast" do
      assert {:error, %Ecto.Changeset{} = cs} =
               Scrollback.insert(sample(0, %{kind: "bogus"}))

      assert "is invalid" in errors_on(cs).kind
    end

    test "rejects missing required fields (universal: network_id/channel/server_time/kind/sender)" do
      assert {:error, %Ecto.Changeset{} = cs} =
               Scrollback.insert(%{network_id: "azzurra", channel: "#x"})

      errors = errors_on(cs)
      assert "can't be blank" in errors.server_time
      assert "can't be blank" in errors.kind
      assert "can't be blank" in errors.sender
      # `body` validation is per-kind, not universal — see "extended kinds"
      # describe block. With kind absent, body validation is skipped.
      refute Map.has_key?(errors, :body)
    end
  end

  describe "extended kinds + nullable body + meta (Task 8 schema future-proofing)" do
    test "accepts :join with nil body and default meta map" do
      assert {:ok, %Message{kind: :join, body: nil, meta: %{}}} =
               Scrollback.insert(%{
                 network_id: "azzurra",
                 channel: "#sniffo",
                 server_time: 0,
                 kind: :join,
                 sender: "alice"
               })
    end

    test "accepts :kick with body (reason) + meta carrying target nick (string-keyed)" do
      assert {:ok, %Message{kind: :kick, body: "rude", meta: %{"target" => "alice"}}} =
               Scrollback.insert(%{
                 network_id: "azzurra",
                 channel: "#sniffo",
                 server_time: 0,
                 kind: :kick,
                 sender: "vjt",
                 body: "rude",
                 # String keys mandatory — see Message moduledoc on
                 # "atom-vs-string footgun." Atom-keyed inserts produce
                 # different shapes via different access paths.
                 meta: %{"target" => "alice"}
               })
    end

    test "rejects :privmsg without body (per-kind body required for content-bearing kinds)" do
      assert {:error, %Ecto.Changeset{} = cs} =
               Scrollback.insert(%{
                 network_id: "azzurra",
                 channel: "#sniffo",
                 server_time: 0,
                 kind: :privmsg,
                 sender: "vjt"
               })

      assert "can't be blank" in errors_on(cs).body
    end

    test "rejects :topic without body (per-kind body required)" do
      assert {:error, %Ecto.Changeset{} = cs} =
               Scrollback.insert(%{
                 network_id: "azzurra",
                 channel: "#sniffo",
                 server_time: 0,
                 kind: :topic,
                 sender: "ChanServ"
               })

      assert "can't be blank" in errors_on(cs).body
    end

    test "accepts all 10 extended kinds with appropriate body/meta shape" do
      cases = [
        {:privmsg, %{body: "hi"}},
        {:notice, %{body: "system notice"}},
        {:action, %{body: "slaps trout"}},
        {:join, %{body: nil}},
        {:part, %{body: nil}},
        {:quit, %{body: "Connection reset"}},
        {:nick_change, %{body: nil, meta: %{"new_nick" => "vjt2"}}},
        {:mode, %{body: nil, meta: %{"modes" => "+o", "args" => ["alice"]}}},
        {:topic, %{body: "new channel topic"}},
        {:kick, %{body: "rude", meta: %{"target" => "alice"}}}
      ]

      for {kind, overrides} <- cases do
        attrs =
          Map.merge(
            %{
              network_id: "azzurra",
              channel: "#sniffo",
              server_time: 0,
              kind: kind,
              sender: "vjt"
            },
            overrides
          )

        assert {:ok, %Message{kind: ^kind}} = Scrollback.insert(attrs),
               "kind #{inspect(kind)} should be accepted"
      end
    end
  end

  describe "Message.to_wire/1 (single-source wire shape for REST + PubSub + Channels)" do
    test "renders a privmsg row to the canonical JSON-shape map" do
      {:ok, msg} = Scrollback.insert(sample(42))

      assert Message.to_wire(msg) == %{
               id: msg.id,
               network_id: "azzurra",
               channel: "#sniffo",
               server_time: 42,
               kind: :privmsg,
               sender: "vjt",
               body: "msg 42",
               meta: %{}
             }
    end

    test "includes meta payload for non-privmsg kinds (string keys mandatory)" do
      {:ok, _} =
        Scrollback.insert(%{
          network_id: "azzurra",
          channel: "#sniffo",
          server_time: 0,
          kind: :nick_change,
          sender: "vjt",
          meta: %{"new_nick" => "vjt2"}
        })

      # Fetch from DB to assert the post-Jason-roundtrip shape — what
      # downstream consumers (REST, PubSub, Channels) actually see.
      [fetched] = Scrollback.fetch("azzurra", "#sniffo", nil, 10)
      wire = Message.to_wire(fetched)
      assert wire.kind == :nick_change
      assert wire.body == nil
      assert wire.meta == %{"new_nick" => "vjt2"}
    end
  end

  describe "fetch/4" do
    test "returns the latest page in descending server_time order" do
      for i <- 0..4, do: {:ok, _} = Scrollback.insert(sample(i))

      page = Scrollback.fetch("azzurra", "#sniffo", nil, 3)

      assert length(page) == 3
      assert Enum.map(page, & &1.body) == ["msg 4", "msg 3", "msg 2"]
    end

    test "paginates by `before` cursor (strict less-than on server_time)" do
      for i <- 0..4, do: {:ok, _} = Scrollback.insert(sample(i))

      [_, last_of_first_page] = Scrollback.fetch("azzurra", "#sniffo", nil, 2)
      next_page = Scrollback.fetch("azzurra", "#sniffo", last_of_first_page.server_time, 2)

      assert Enum.map(next_page, & &1.body) == ["msg 2", "msg 1"]
    end

    test "isolates rows by (network_id, channel)" do
      {:ok, _} = Scrollback.insert(sample(0, %{channel: "#a"}))
      {:ok, _} = Scrollback.insert(sample(1, %{channel: "#b"}))
      {:ok, _} = Scrollback.insert(sample(2, %{network_id: "freenode"}))

      page = Scrollback.fetch("azzurra", "#a", nil, 10)
      assert length(page) == 1
      assert hd(page).channel == "#a"
    end

    test "returns [] when nothing matches" do
      assert Scrollback.fetch("azzurra", "#empty", nil, 10) == []
    end

    test "clamps limit to max_page_size/0 (anti-DoS, proves the cap actually fires)" do
      cap = Scrollback.max_page_size()

      # Insert cap+5 rows so the cap MUST clip the result. A weaker test
      # (fewer rows than cap) would pass even if the clamp were removed.
      for i <- 0..(cap + 4), do: {:ok, _} = Scrollback.insert(sample(i))

      page = Scrollback.fetch("azzurra", "#sniffo", nil, cap + 1_000)
      assert length(page) == cap
    end

    test "raises FunctionClauseError on non-positive limit (let it crash)" do
      assert_raise FunctionClauseError, fn ->
        Scrollback.fetch("azzurra", "#sniffo", nil, 0)
      end
    end
  end

  defp errors_on(changeset) do
    Ecto.Changeset.traverse_errors(changeset, fn {message, opts} ->
      Regex.replace(~r"%{(\w+)}", message, fn _, key ->
        opts |> Keyword.get(String.to_existing_atom(key), key) |> to_string()
      end)
    end)
  end
end
