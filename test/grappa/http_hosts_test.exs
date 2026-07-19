defmodule Grappa.HttpHostsTest do
  # async: false — mutates the process-global `:persistent_term` key.
  use ExUnit.Case, async: false

  alias Grappa.HttpHosts

  setup do
    # Snapshot + restore so a stashed set doesn't leak into other
    # suites that read HttpHosts.aliases/0 (server_settings_test etc).
    prior = HttpHosts.aliases()
    on_exit(fn -> :ok = HttpHosts.boot(prior) end)
    :ok
  end

  describe "boot/1 + aliases/0" do
    test "aliases/0 returns the booted list" do
      :ok = HttpHosts.boot(["irc.sindro.me", "irc.sniffo.org"])
      assert HttpHosts.aliases() == ["irc.sindro.me", "irc.sniffo.org"]
    end

    test "boot/1 overwrites (last write wins)" do
      :ok = HttpHosts.boot(["a.example"])
      :ok = HttpHosts.boot(["b.example", "c.example"])
      assert HttpHosts.aliases() == ["b.example", "c.example"]
    end

    test "boot/1 with an empty list yields an empty alias set" do
      :ok = HttpHosts.boot([])
      assert HttpHosts.aliases() == []
    end
  end
end
