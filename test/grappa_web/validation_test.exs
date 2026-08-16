defmodule GrappaWeb.ValidationTest do
  @moduledoc """
  Unit tests for the boundary-shape validators shared by the JSON REST
  controllers.

  `take_atomized/2,3` (codebase review S22) is the single atomize helper
  the five admin controllers route their PATCH/POST whitelists through.
  It is asserted here directly — the controller tests assert each
  whitelist's key set is unchanged, this asserts the shared reduce's
  present-key / atomize / value-hook contract in isolation.
  """
  use ExUnit.Case, async: true

  alias GrappaWeb.Validation

  describe "take_atomized/2" do
    test "keeps only whitelisted keys present in params, atomized" do
      params = %{"name" => "irc.example.org", "port" => 6697}

      assert Validation.take_atomized(params, ["name", "port"]) ==
               %{name: "irc.example.org", port: 6697}
    end

    test "omits a whitelisted key absent from params (no nil fill)" do
      params = %{"name" => "irc.example.org"}

      assert Validation.take_atomized(params, ["name", "port"]) == %{name: "irc.example.org"}
    end

    test "ignores a params key that is not whitelisted" do
      params = %{"name" => "irc.example.org", "rogue" => "x"}

      assert Validation.take_atomized(params, ["name"]) == %{name: "irc.example.org"}
    end

    test "returns an empty map when no whitelisted key is present (valid no-op)" do
      assert Validation.take_atomized(%{"other" => 1}, ["name", "port"]) == %{}
    end

    test "preserves a null value for a present key (clear-the-field semantics)" do
      assert Validation.take_atomized(%{"port" => nil}, ["port"]) == %{port: nil}
    end
  end

  describe "validate_channel_list/1 (#382)" do
    test "a single channel is :ok (list-of-one)" do
      assert Validation.validate_channel_list("#chan") == :ok
    end

    test "a comma-separated list of valid channels is :ok" do
      assert Validation.validate_channel_list("#a,#b,#c") == :ok
    end

    test "any invalid member fails the WHOLE line" do
      assert Validation.validate_channel_list("#a,no-hash,#c") == {:error, :bad_request}
    end

    test "an empty string is rejected" do
      assert Validation.validate_channel_list("") == {:error, :bad_request}
    end

    test "a trailing comma (empty trailing element) is rejected" do
      assert Validation.validate_channel_list("#a,") == {:error, :bad_request}
    end
  end

  describe "take_atomized/3" do
    test "threads each retained value through value_fun keyed by its string key" do
      params = %{"auth_method" => "sasl", "nick" => "vjt"}

      fun = fn
        "auth_method", v -> String.to_atom(v)
        _, v -> v
      end

      assert Validation.take_atomized(params, ["auth_method", "nick"], fun) ==
               %{auth_method: :sasl, nick: "vjt"}
    end

    test "value_fun never runs for an absent whitelisted key" do
      fun = fn
        "sasl_user", _ -> raise "must not be called for an absent key"
        _, v -> v
      end

      assert Validation.take_atomized(%{"nick" => "vjt"}, ["nick", "sasl_user"], fun) ==
               %{nick: "vjt"}
    end
  end

  # #1301 — `/notice @#chan` was refused as malformed. The wire recipient of a
  # NOTICE/CTCP is not a window key: it may carry the network's STATUSMSG
  # sigils, which are neither a channel prefix nor a nick character, so the
  # raw target matched neither validator and the POST 400ed.
  #
  # This is a SEPARATE validator rather than a widening of
  # `validate_post_target_name/1`: that one also guards the `channel_id` arm,
  # where the target IS the persist key, so admitting `@#chan` there would
  # manufacture a phantom `@#chan` window on the outbound side — the exact
  # defect #1303 fixes on the inbound side.
  describe "validate_wire_recipient_name/2 (#1301)" do
    @bahamut ["@", "+"]
    @halfop ["@", "%", "+"]

    test "accepts an ops-level channel target — the reported case" do
      assert Validation.validate_wire_recipient_name("@#chan", @bahamut) == :ok
    end

    test "accepts a multi-sigil target: the ircd is the authority on what it means" do
      assert Validation.validate_wire_recipient_name("@%#chan", @halfop) == :ok
    end

    test "the sigil set is per-network: an unadvertised level is not a sigil" do
      # A `%` prefix on bahamut (`STATUSMSG=@+`) is not a level — it is a
      # channel name starting with `%`, which is not a legal channel.
      assert Validation.validate_wire_recipient_name("%#chan", @bahamut) ==
               {:error, :bad_request}

      assert Validation.validate_wire_recipient_name("%#chan", @halfop) == :ok
    end

    test "a plain channel and a plain nick are unaffected" do
      assert Validation.validate_wire_recipient_name("#chan", @bahamut) == :ok
      assert Validation.validate_wire_recipient_name("carol", @bahamut) == :ok
      assert Validation.validate_wire_recipient_name("+chan", @bahamut) == :ok
    end

    test "a sigil does not smuggle the read-only $server synthetic" do
      # `validate_post_target_name/1` rejects `$server` because a write to it
      # is an RFC 2812 server-mask PRIVMSG. Peeling must not open a side door:
      # `@` in front of it peels nothing (there is no channel behind it), so
      # the refusal stands on the raw target.
      assert Validation.validate_wire_recipient_name("$server", @bahamut) ==
               {:error, :bad_request}

      assert Validation.validate_wire_recipient_name("@$server", @bahamut) ==
               {:error, :bad_request}
    end

    test "a sigil in front of a NICK is not a STATUSMSG target" do
      # STATUSMSG addresses a channel at a membership level. `@carol` is
      # neither a channel nor a legal nick, and inventing an acceptance for it
      # would ship a target no ircd can route.
      assert Validation.validate_wire_recipient_name("@carol", @bahamut) ==
               {:error, :bad_request}
    end

    test "the peel does not weaken the channel-shape check behind it" do
      # The peel tests only the first byte of the remainder; the FULL channel
      # validator still runs on it. A space or a CRLF behind a sigil must stay
      # refused — the alternative is a target that splits the wire line.
      assert Validation.validate_wire_recipient_name("@#with space", @bahamut) ==
               {:error, :bad_request}

      assert Validation.validate_wire_recipient_name("@#chan\r\nQUIT", @bahamut) ==
               {:error, :bad_request}
    end

    test "an empty advertised set falls back to the plain target rules" do
      assert Validation.validate_wire_recipient_name("#chan", []) == :ok
      assert Validation.validate_wire_recipient_name("@#chan", []) == {:error, :bad_request}
    end
  end
end
