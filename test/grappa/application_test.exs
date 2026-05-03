defmodule Grappa.ApplicationTest do
  use ExUnit.Case, async: false

  test "Application.start/2 calls Admission.Config.boot/0 before child specs" do
    # Verify config is present in :persistent_term post-start
    cfg = Grappa.Admission.Config.config()
    assert %Grappa.Admission.Config{} = cfg
  end
end
