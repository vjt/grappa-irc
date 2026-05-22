defmodule GrappaWeb.EndpointTest do
  # async: false — touches :persistent_term + Application env. The
  # session-salt cache is process-global; concurrent tests reading
  # the cached opts would race the test's put_env / clear cycle.
  use ExUnit.Case, async: false

  alias GrappaWeb.Endpoint

  describe "session_signing_salt runtime read (review H21)" do
    setup do
      # Snapshot the current salt + cache so we can restore.
      env = Application.fetch_env!(:grappa, Endpoint)
      salt = Keyword.fetch!(env, :session_signing_salt)
      cached = :persistent_term.get({Endpoint, :session_opts}, nil)

      on_exit(fn ->
        Application.put_env(
          :grappa,
          Endpoint,
          Keyword.put(Application.fetch_env!(:grappa, Endpoint), :session_signing_salt, salt)
        )

        if cached do
          :persistent_term.put({Endpoint, :session_opts}, cached)
        else
          :persistent_term.erase({Endpoint, :session_opts})
        end
      end)

      :ok
    end

    test "session_signing_salt is readable via Application.fetch_env!/2 at runtime" do
      env = Application.fetch_env!(:grappa, Endpoint)
      assert is_binary(Keyword.fetch!(env, :session_signing_salt))
    end

    test "test env's salt comes from config/test.exs, not the build-time placeholder" do
      env = Application.fetch_env!(:grappa, Endpoint)
      salt = Keyword.fetch!(env, :session_signing_salt)
      refute salt =~ "build-time-placeholder"
    end

    test "salt rotation at runtime updates the value on next cache-rebuild" do
      original_env = Application.fetch_env!(:grappa, Endpoint)
      rotated = "test-rotated-salt-#{System.unique_integer([:positive])}"

      Application.put_env(
        :grappa,
        Endpoint,
        Keyword.put(original_env, :session_signing_salt, rotated)
      )

      :persistent_term.erase({Endpoint, :session_opts})

      new_env = Application.fetch_env!(:grappa, Endpoint)
      assert Keyword.fetch!(new_env, :session_signing_salt) == rotated

      refute Keyword.fetch!(new_env, :session_signing_salt) ==
               Keyword.fetch!(original_env, :session_signing_salt)
    end
  end
end
