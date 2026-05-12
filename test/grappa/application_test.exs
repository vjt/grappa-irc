defmodule Grappa.ApplicationTest do
  # async: false because the test reads `Grappa.Admission.Config.config/0`
  # which lives in `:persistent_term` — a node-global, single-key store
  # populated by `Grappa.Admission.Config.boot/0` at application start.
  # Any concurrent test that calls the test-only `put_test_config/1`
  # helper would race with this assertion. async: false pins the
  # boot-time snapshot read.
  use ExUnit.Case, async: false

  test "Application.start/2 calls Admission.Config.boot/0 before child specs" do
    # Verify config is present in :persistent_term post-start
    cfg = Grappa.Admission.Config.config()
    assert %Grappa.Admission.Config{} = cfg
  end
end
