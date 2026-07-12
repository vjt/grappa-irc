defmodule Grappa.Networks.WireTest do
  @moduledoc """
  Tests for `Grappa.Networks.Wire` — the public JSON shape for
  `Networks.Credential` and `Networks.Network` rows.

  The CRITICAL invariant: the credential JSON output MUST NOT include
  `:password_encrypted` (which post-Cloak-load carries the upstream
  IRC password as plaintext-in-memory) NOR the virtual `:password`
  field (input-only, but defensively excluded too). `redact: true`
  on the schema only protects `inspect/1` and Logger; `Jason.encode!/1`
  walks the struct fields directly. Without an explicit allowlist
  serializer, the first naive Phase 3 `GET /networks` controller
  emitting `Jason.encode!(credential)` would leak the NickServ
  password to JSON.
  """
  use Grappa.DataCase, async: true

  alias Grappa.{Accounts, Networks, Repo}
  alias Grappa.Networks.{Credential, Credentials, Wire}

  setup do
    {:ok, user} =
      Accounts.create_user(%{
        name: "vjt-#{System.unique_integer([:positive])}",
        password: "correct horse battery"
      })

    {:ok, network} =
      Networks.find_or_create_network(%{slug: "azzurra-#{System.unique_integer([:positive])}"})

    %{user: user, network: network}
  end

  describe "credential_to_json/1" do
    test "renders the public credential shape (slug under :network)",
         %{user: user, network: network} do
      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          ident: "grp",
          realname: "Marcello",
          sasl_user: "vjt",
          auth_method: :sasl,
          password: "shibboleth",
          autojoin_channels: ["#grappa"]
        })

      cred = user |> Credentials.get_credential!(network) |> Repo.preload(:network)

      json = Wire.credential_to_json(cred)

      assert json.network == network.slug
      assert json.nick == "vjt"
      assert json.ident == "grp"
      assert json.realname == "Marcello"
      assert json.sasl_user == "vjt"
      assert json.auth_method == :sasl
      assert json.autojoin_channels == ["#grappa"]
      # Timestamps land as ISO-8601 strings on the wire (bnd-A11);
      # the dedicated test below pins the round-trip shape.
      assert is_binary(json.inserted_at)
      assert is_binary(json.updated_at)
    end

    # CRITICAL — the whole point of this module. If this assertion ever
    # regresses, the next deployed `GET /networks` endpoint leaks the
    # upstream NickServ password to the world.
    test "NEVER includes :password_encrypted nor :password",
         %{user: user, network: network} do
      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          auth_method: :nickserv_identify,
          password: "leak-canary-please-never-appear"
        })

      cred = user |> Credentials.get_credential!(network) |> Repo.preload(:network)

      # Sanity-check the precondition: post-load Cloak has decrypted
      # the AES-GCM ciphertext into plaintext-in-memory.
      assert cred.password_encrypted == "leak-canary-please-never-appear"

      json = Wire.credential_to_json(cred)

      refute Map.has_key?(json, :password_encrypted)
      refute Map.has_key?(json, :password)

      # And the canary string must not appear ANYWHERE in the JSON
      # (defends against a future field that accidentally carries it).
      json_string = Jason.encode!(json)
      refute json_string =~ "leak-canary-please-never-appear"
    end

    test "crashes loudly on unloaded :network assoc",
         %{user: user, network: network} do
      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          auth_method: :none
        })

      cred = Credentials.get_credential!(user, network)
      # `get_credential!/2` returns the row WITHOUT preloading :network.
      assert match?(%Ecto.Association.NotLoaded{}, cred.network)

      assert_raise FunctionClauseError, fn -> Wire.credential_to_json(cred) end
    end

    test "is Jason-encodable without raising",
         %{user: user, network: network} do
      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          auth_method: :none
        })

      cred = user |> Credentials.get_credential!(network) |> Repo.preload(:network)

      assert is_binary(Jason.encode!(Wire.credential_to_json(cred)))
    end

    # Architecture audit bnd-A11: timestamps on the wire must be
    # ISO-8601 strings, not raw `%DateTime{}` structs. The cic-side TS
    # contract (`api.ts` `CredentialJson`) declares `inserted_at:
    # string` etc. — the typespec was lying about the wire shape.
    test "renders timestamps as ISO-8601 strings (cic contract)",
         %{user: user, network: network} do
      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          auth_method: :none
        })

      cred = user |> Credentials.get_credential!(network) |> Repo.preload(:network)

      json = Wire.credential_to_json(cred)

      # Convert-at-the-Wire-boundary: the field is a binary on output,
      # not a `%DateTime{}` (which would still encode correctly through
      # Jason but lie about the typespec).
      assert is_binary(json.inserted_at)
      assert is_binary(json.updated_at)
      # ISO-8601 sanity round-trip.
      assert {:ok, _, 0} = DateTime.from_iso8601(json.inserted_at)
      assert {:ok, _, 0} = DateTime.from_iso8601(json.updated_at)
    end

    test "connection_state_changed_at: nil → nil; %DateTime{} → ISO-8601 string",
         %{user: user, network: network} do
      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          auth_method: :none
        })

      cred = user |> Credentials.get_credential!(network) |> Repo.preload(:network)

      # bind_credential defaults to `DateTime.utc_now/0`; assert
      # iso-8601 round-trip.
      with_default = Wire.credential_to_json(cred)
      assert is_binary(with_default.connection_state_changed_at)
      assert {:ok, _, 0} = DateTime.from_iso8601(with_default.connection_state_changed_at)

      # Force-clear to nil and re-render — `iso8601_or_nil/1` must
      # preserve the nullability through the wire boundary.
      cleared = Wire.credential_to_json(%{cred | connection_state_changed_at: nil})
      assert cleared.connection_state_changed_at == nil
    end
  end

  describe "visitor_network_to_json/3 (#211 phase 6 — visitor GET /networks row)" do
    test "renders the visitor twin shape (kind: :visitor, nick, connection_state)",
         %{network: network} do
      cred = %Credential{
        network: network,
        nick: "vjt",
        connection_state: :connected,
        connection_state_reason: nil,
        connection_state_changed_at: DateTime.truncate(DateTime.utc_now(), :second)
      }

      json = Wire.visitor_network_to_json(network, "vjt-live", cred)

      assert json.kind == :visitor
      assert json.id == network.id
      assert json.slug == network.slug
      # nick is the caller-passed live-nick, NOT necessarily cred.nick.
      assert json.nick == "vjt-live"
      assert json.connection_state == :connected
      assert json.connection_state_reason == nil
      assert is_binary(json.connection_state_changed_at)
      # Timestamps land as ISO-8601 strings on the wire (bnd-A11).
      assert is_binary(json.inserted_at)
      assert is_binary(json.updated_at)
    end

    test "carries a parked credential's reason + state (persistent park, ruling D)",
         %{network: network} do
      cred = %Credential{
        network: network,
        nick: "vjt",
        connection_state: :parked,
        connection_state_reason: "user-disconnect",
        connection_state_changed_at: DateTime.truncate(DateTime.utc_now(), :second)
      }

      json = Wire.visitor_network_to_json(network, "vjt", cred)

      assert json.connection_state == :parked
      assert json.connection_state_reason == "user-disconnect"
    end

    test "is Jason-encodable", %{network: network} do
      cred = %Credential{
        network: network,
        nick: "vjt",
        connection_state: :connected,
        connection_state_changed_at: DateTime.truncate(DateTime.utc_now(), :second)
      }

      assert is_binary(Jason.encode!(Wire.visitor_network_to_json(network, "vjt", cred)))
    end
  end

  describe "Credential.upstream_password/1" do
    test "returns the post-Cloak-load plaintext upstream secret",
         %{user: user, network: network} do
      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          auth_method: :server_pass,
          password: "shibboleth"
        })

      cred = Credentials.get_credential!(user, network)

      assert Credential.upstream_password(cred) == "shibboleth"
    end

    test "returns nil for :none credentials with no stored password",
         %{user: user, network: network} do
      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          auth_method: :none
        })

      cred = Credentials.get_credential!(user, network)

      assert Credential.upstream_password(cred) == nil
    end
  end

  # Defense-in-depth: prove that handing the raw schema struct to
  # Jason — i.e., what a naive controller might do before A1 was
  # written — would have leaked. This isn't a regression test for the
  # Wire module itself; it's a contract on the schema's behaviour
  # under JSON encoding so future readers understand WHY Wire exists.
  describe "raw-struct Jason regression canary" do
    test "raw Credential leaks password_encrypted (this is what Wire prevents)",
         %{user: user, network: network} do
      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          auth_method: :sasl,
          password: "DO-NOT-LEAK"
        })

      cred = Credentials.get_credential!(user, network)

      # Jason can't encode an Ecto schema struct without `@derive` —
      # the raw struct path either raises Protocol.UndefinedError OR,
      # if a future @derive opens it up, leaks. Assert the current
      # state is the safe one (raise) so a future @derive Jason.Encoder
      # on Credential trips this canary and forces the author to use
      # Wire.credential_to_json/1 instead.
      assert_raise Protocol.UndefinedError, fn -> Jason.encode!(cred) end
    end

    test "raw Network leaks fields too (this is what Wire prevents)",
         %{network: network} do
      assert_raise Protocol.UndefinedError, fn -> Jason.encode!(network) end
    end
  end

  describe "channel_to_json/3 (P4-1 A5 wire)" do
    test "renders {name, joined, source} for an autojoin-joined channel" do
      assert %{name: "#italia", joined: true, source: :autojoin} =
               Wire.channel_to_json("#italia", true, :autojoin)
    end

    test "renders {name, joined, source} for an autojoin-but-parted channel" do
      assert %{name: "#italia", joined: false, source: :autojoin} =
               Wire.channel_to_json("#italia", false, :autojoin)
    end

    test "renders {name, joined, source} for a session-joined channel (not in autojoin)" do
      assert %{name: "#bnc", joined: true, source: :joined} =
               Wire.channel_to_json("#bnc", true, :joined)
    end
  end

  describe "connection_state_changed_event/5 (CP16 B3, REV-J M15 fold)" do
    test "renders the wire payload from a credential + transition tuple + nick",
         %{user: user, network: network} do
      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          realname: "Marcello",
          sasl_user: "vjt",
          auth_method: :sasl,
          password: "shibboleth",
          autojoin_channels: ["#grappa"]
        })

      %Credential{} =
        cred = user |> Credentials.get_credential!(network) |> Repo.preload([:user, :network])

      now = DateTime.utc_now()

      # REV-J M15: the folded `:network` field carries `home_network_row/2`
      # of the credential POST-transition. Caller (Networks.broadcast_state_change/4)
      # passes the row with the new state already written; the test mirrors
      # that by setting connection_state on the fixture struct.
      cred = %Credential{cred | connection_state: :parked, connection_state_changed_at: now}

      payload =
        Wire.connection_state_changed_event(cred, :connected, :parked, "operator paused", "vjt-live")

      assert payload == %{
               kind: "connection_state_changed",
               user_id: cred.user_id,
               network_id: cred.network_id,
               network_slug: network.slug,
               from: :connected,
               to: :parked,
               reason: "operator paused",
               at: DateTime.to_iso8601(now),
               network: %{
                 slug: network.slug,
                 nick: "vjt-live",
                 connection_state: :parked,
                 connection_state_reason: nil,
                 connection_state_changed_at: DateTime.to_iso8601(now)
               }
             }
    end

    test "tolerates nil reason (state-change without operator note)",
         %{user: user, network: network} do
      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          realname: "Marcello",
          sasl_user: "vjt",
          auth_method: :sasl,
          password: "shibboleth",
          autojoin_channels: ["#grappa"]
        })

      cred = user |> Credentials.get_credential!(network) |> Repo.preload([:user, :network])

      payload = Wire.connection_state_changed_event(cred, :parked, :connected, nil, "vjt")

      assert payload.reason == nil
      assert payload.from == :parked
      assert payload.to == :connected
      assert payload.kind == "connection_state_changed"
      assert payload.network.nick == "vjt"
    end
  end

  # UX-4 bucket B (2026-05-18); REV-J M15 (2026-05-22). The home pane's
  # per-row payload is the narrow projection consumed by HomePane on
  # cold-load (via /me's `home_data` envelope) AND by HomePane on live
  # updates (via the `:network` field of `connection_state_changed`).
  # Both reads go through the shared `home_network_row/2` builder so
  # the wire shape is one edit, not two — the wire-parity test below
  # pins that invariant.
  describe "home_network_row/2 (UX-4 B)" do
    test "renders {slug, nick, connection_state, ...} from a preloaded credential",
         %{user: user, network: network} do
      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          auth_method: :none
        })

      cred = user |> Credentials.get_credential!(network) |> Repo.preload(:network)

      row = Wire.home_network_row(cred, "vjt-live")

      assert row.slug == network.slug
      assert row.nick == "vjt-live"
      assert row.connection_state == :connected
      assert row.connection_state_reason == nil
      # bind_credential defaults `connection_state_changed_at` to now; the
      # wire boundary converts to ISO-8601.
      assert is_binary(row.connection_state_changed_at)
      assert {:ok, _, 0} = DateTime.from_iso8601(row.connection_state_changed_at)
    end

    test "surfaces nil connection_state_changed_at as nil on the wire",
         %{user: user, network: network} do
      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          auth_method: :none
        })

      cred = user |> Credentials.get_credential!(network) |> Repo.preload(:network)

      row =
        Wire.home_network_row(
          %{cred | connection_state_changed_at: nil},
          "vjt"
        )

      assert row.connection_state_changed_at == nil
    end

    test "crashes loudly on unloaded :network assoc (mirror of credential_to_json/1)",
         %{user: user, network: network} do
      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          auth_method: :none
        })

      cred = Credentials.get_credential!(user, network)
      assert match?(%Ecto.Association.NotLoaded{}, cred.network)

      assert_raise FunctionClauseError, fn -> Wire.home_network_row(cred, "vjt") end
    end

    test "rejects empty/non-string nick (defensive — caller bug)",
         %{user: user, network: network} do
      {:ok, _} =
        Credentials.bind_credential(user, network, %{nick: "vjt", auth_method: :none})

      cred = user |> Credentials.get_credential!(network) |> Repo.preload(:network)

      assert_raise FunctionClauseError, fn -> Wire.home_network_row(cred, "") end
      assert_raise FunctionClauseError, fn -> Wire.home_network_row(cred, nil) end
    end
  end

  describe "home_data/1 (UX-4 B)" do
    test "renders %{networks: [...]} from a list of (cred, nick) pairs",
         %{user: user, network: network} do
      {:ok, _} =
        Credentials.bind_credential(user, network, %{
          nick: "vjt",
          auth_method: :none
        })

      cred = user |> Credentials.get_credential!(network) |> Repo.preload(:network)

      envelope = Wire.home_data([{cred, "vjt-live"}])

      assert %{networks: [row]} = envelope
      assert row.slug == network.slug
      assert row.nick == "vjt-live"
    end

    test "renders %{networks: []} for an empty list (user with no credentials)" do
      assert Wire.home_data([]) == %{networks: []}
    end
  end
end
