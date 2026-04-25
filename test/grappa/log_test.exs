defmodule Grappa.LogTest do
  use ExUnit.Case, async: false

  alias Grappa.Log

  require Logger

  describe "session_context/2" do
    test "returns canonical [user:, network:] keyword list" do
      assert Log.session_context("vjt", "azzurra") == [user: "vjt", network: "azzurra"]
    end
  end

  describe "set_session_context/2" do
    test "installs user and network into the calling process's Logger metadata" do
      Log.set_session_context("alice", "freenode")

      meta = Logger.metadata()

      assert meta[:user] == "alice"
      assert meta[:network] == "freenode"
    after
      Logger.reset_metadata()
    end

    test "overwrites prior context on second call" do
      Log.set_session_context("first", "neta")
      Log.set_session_context("second", "netb")

      assert Logger.metadata()[:user] == "second"
      assert Logger.metadata()[:network] == "netb"
    after
      Logger.reset_metadata()
    end
  end
end
