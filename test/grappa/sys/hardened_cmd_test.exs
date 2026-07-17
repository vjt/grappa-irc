defmodule Grappa.Sys.HardenedCmdTest do
  use ExUnit.Case, async: true

  alias Grappa.Sys.HardenedCmd

  test "returns combined output on a zero exit" do
    assert {:ok, output} = HardenedCmd.run("echo", ["hello"], 5)
    assert String.trim(output) == "hello"
  end

  test "maps a non-zero exit to {:exit, code, output}" do
    assert {:error, {:exit, 3, _}} = HardenedCmd.run("sh", ["-c", "exit 3"], 5)
  end

  test "kills and reports :timeout when the child overruns its budget" do
    assert {:error, :timeout} = HardenedCmd.run("sleep", ["5"], 1)
  end

  test "reports the missing executable by name" do
    assert {:error, {:exe_not_found, "grappa-nonexistent-binary"}} =
             HardenedCmd.run("grappa-nonexistent-binary", [], 5)
  end
end
