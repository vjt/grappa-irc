defmodule Grappa.Deploy.Manifest do
  @moduledoc """
  What this build was compiled from, for the files a package upgrade's
  hot-vs-cold verdict turns on (issue 1112) — and the door
  `infra/packaging/apply-upgrade.sh` reads that verdict through.

  A deb/rpm/Arch upgrade has no git range to diff: the running node was
  built from one tree, the package has just written the release of
  another, and neither tree is on the host. So each build carries its own
  `t:Grappa.Deploy.Preflight.manifest/0`, computed at COMPILE time from
  `Grappa.Deploy.Preflight.manifest_paths/1`:

    * the running node reports the one compiled into the code it runs
      (`encode/0`, over `grappa rpc`);
    * the new release, booted by `grappa eval`, compares it with its own
      (`cli/1` → `Grappa.Deploy.Preflight.classify_manifests/4`).

  A module and not a file on disk, because the package overwrites files:
  a manifest written next to the release would describe the NEW tree by
  the time anyone read it as the old one. A module is the running node's
  own memory of its code — and a hot reload reloads this beam with the
  rest (it changes whenever a watched file does), so there is no parallel
  state to keep in step.

  Recompilation follows the watched files: each is an `@external_resource`,
  and `__mix_recompile__?/0` catches a file that is NEW (a migration) or
  gone, which no `@external_resource` can name in advance. A watched file
  absent from the build context is recorded as `nil` — it fails safe (a
  `nil` that becomes a hash is a change, so COLD) and never breaks the
  compile.
  """

  use Boundary, top_level?: true, deps: [Grappa.Deploy.Preflight]

  alias Grappa.Deploy.Preflight

  root = Path.expand("../../..", __DIR__)
  paths = Preflight.manifest_paths(root)

  sources =
    Map.new(paths, fn path ->
      case File.read(Path.join(root, path)) do
        {:ok, source} -> {path, source}
        {:error, _} -> {path, nil}
      end
    end)

  for {path, source} <- sources, is_binary(source) do
    @external_resource Path.join(root, path)
  end

  @root root
  @paths_digest :erlang.phash2(paths)
  @manifest Preflight.build_manifest(sources)

  # The transport's version tag: a reader refuses a format it does not know
  # rather than guess at one.
  @format 1

  @doc "The manifest compiled into this build."
  @spec current() :: Preflight.manifest()
  def current, do: @manifest

  @doc """
  `current/0`, encoded for `grappa rpc` to print: JSON text. Every entry
  is a hex digest or `nil`, so no Erlang term has to cross — the reader
  never decodes one from a file.
  """
  @spec encode() :: String.t()
  def encode, do: encode(current())

  @doc "Encode a manifest the way `encode/0` does."
  @spec encode(Preflight.manifest()) :: String.t()
  def encode(%{files: files, state_blocks: blocks}) do
    Jason.encode!(%{grappa_manifest: @format, files: files, state_blocks: blocks})
  end

  @doc """
  Decode what `encode/0` printed. `{:error, :unknown_format}` for anything
  else — malformed text, another format version, an entry that is not a
  digest — never a guess.
  """
  @spec decode(String.t()) :: {:ok, Preflight.manifest()} | {:error, :unknown_format}
  def decode(text) when is_binary(text) do
    with {:ok, %{"grappa_manifest" => @format, "files" => files, "state_blocks" => blocks}}
         when is_map(files) and is_map(blocks) <- Jason.decode(text),
         true <- Enum.all?(Map.values(files), &(is_binary(&1) or is_nil(&1))),
         true <- Enum.all?(Map.values(blocks), &is_binary/1) do
      {:ok, %{files: files, state_blocks: blocks}}
    else
      _ -> {:error, :unknown_format}
    end
  end

  @doc """
  The verdict for `cli/1`: `[path]` names the file holding the running
  node's encoded manifest. Returns the exit code and the text to print —
  `0` HOT and `3` COLD, as `Grappa.Deploy.Preflight.cli/1`; an unreadable
  or undecodable file is `3` too, with the reason (no verdict is a cold
  one); anything but one path is `2`, a usage error.
  """
  @spec run([String.t()]) :: {0 | 2 | 3, String.t()}
  def run([path]) when is_binary(path) do
    with {:ok, text} <- File.read(path),
         {:ok, from} <- decode(text) do
      verdict = Preflight.classify_manifests(from, current(), :package, &release_source/1)
      {Preflight.exit_code(verdict), Preflight.render(verdict)}
    else
      {:error, :unknown_format} ->
        {3, "verdict unavailable: #{path} does not hold a manifest this release can read\n"}

      {:error, posix} ->
        {3, "verdict unavailable: cannot read #{path}: #{:file.format_error(posix)}\n"}
    end
  end

  def run(_) do
    {2, "usage: grappa eval 'Grappa.Deploy.Manifest.cli(System.argv())' <manifest-file>\n"}
  end

  @doc """
  Entry point for `apply-upgrade.sh`: prints `run/1`'s text and halts with
  its code. Shell callers case on the code — 0 hot, 3 cold, anything else
  a crash, never a verdict.
  """
  @spec cli([String.t()]) :: no_return()
  def cli(argv) do
    {code, text} = run(argv)
    IO.write(if(code == 2, do: :stderr, else: :stdio), text)
    System.halt(code)
  end

  @doc false
  # Mix asks this before trusting the compiled beam: true when the set of
  # watched paths moved (a file added or removed), which no
  # @external_resource can express.
  @spec __mix_recompile__?() :: boolean()
  def __mix_recompile__?, do: :erlang.phash2(Preflight.manifest_paths(@root)) != @paths_digest

  # A migration's source as the NEW release ships it — the repo-relative
  # path is relative to the application directory.
  defp release_source(path) do
    case File.read(Application.app_dir(:grappa, path)) do
      {:ok, source} -> source
      {:error, _} -> nil
    end
  end
end
