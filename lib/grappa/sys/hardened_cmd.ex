defmodule Grappa.Sys.HardenedCmd do
  @moduledoc """
  Run an external command under a hard wall-clock timeout with a scrubbed
  environment.

  Two grappa subsystems shell out to media tools that parse HOSTILE user bytes
  (`Grappa.Uploads.MetadataStrip` — exiftool/ffmpeg strip; `Grappa.Themes`
  background-image re-encode — ffmpeg). Both need the same hardening, so it lives
  here once:

    * **Wall-clock ceiling** — `System.cmd/3` has no timeout, so a crafted file
      that wedges the tool would pin the request process (and the OS child)
      forever. We wrap every invocation in `timeout(1)` with `-s KILL`
      (SIGKILL — the tools are stateless over tmp files, nothing graceful to
      preserve). `timeout` ships in busybox (alpine container) and FreeBSD base
      (m42 jail). Its expired-child exit codes are 124 (default TERM) and 137
      (128+9, when `-s KILL` is delivered) → both mapped to `{:error, :timeout}`.

    * **Env scrub (RCE containment)** — exiftool has an RCE history
      (CVE-2021-22204); a compromised child must not find the deployment's
      secrets in its environment. ALLOWLIST, not denylist: the child keeps only
      what a media tool needs (`@kept_env`), so a secret added tomorrow cannot
      leak by omission. `{name, nil}` REMOVES the variable (vs `env: []`, which
      only adds nothing).

  Argument lists only — never shell interpolation. The command is always looked
  up on `PATH` via `System.find_executable/1` so a missing binary is a tagged
  error, not a crash.
  """
  use Boundary, top_level?: true, deps: []

  # See moduledoc — child keeps only what a media tool needs.
  @kept_env ~w(PATH HOME LANG LC_ALL TMPDIR)
  # GNU/busybox/FreeBSD `timeout` exit codes for an expired child.
  @timeout_exit_codes [124, 137]

  @type result ::
          {:ok, output :: String.t()}
          | {:error, {:exe_not_found, String.t()}}
          | {:error, :timeout}
          | {:error, {:exit, non_neg_integer(), output :: String.t()}}

  @doc """
  Run `exe_name args` under `timeout -s KILL timeout_s` with a scrubbed env.

  Returns `{:ok, combined_stdout_stderr}` on exit 0; `{:error, :timeout}` when
  the wall-clock budget was exceeded; `{:error, {:exit, code, output}}` on any
  other non-zero exit; `{:error, {:exe_not_found, name}}` when `timeout` or the
  target binary is not on `PATH`.
  """
  @spec run(String.t(), [String.t()], pos_integer()) :: result()
  def run(exe_name, args, timeout_s)
      when is_binary(exe_name) and is_list(args) and is_integer(timeout_s) and timeout_s > 0 do
    with {:ok, timeout_exe} <- find_exe("timeout"),
         {:ok, _} <- find_exe(exe_name) do
      argv = ["-s", "KILL", Integer.to_string(timeout_s), exe_name | args]

      case System.cmd(timeout_exe, argv, env: scrubbed_env(), stderr_to_stdout: true) do
        {output, 0} -> {:ok, output}
        {_, code} when code in @timeout_exit_codes -> {:error, :timeout}
        {output, code} -> {:error, {:exit, code, String.trim(output)}}
      end
    end
  end

  defp find_exe(name) do
    case System.find_executable(name) do
      nil -> {:error, {:exe_not_found, name}}
      _ -> {:ok, name}
    end
  end

  defp scrubbed_env do
    for {name, _} <- System.get_env(), name not in @kept_env, do: {name, nil}
  end
end
