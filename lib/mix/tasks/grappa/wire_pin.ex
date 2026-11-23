defmodule Mix.Tasks.Grappa.WirePin do
  @shortdoc "Fail when the wire shape moved and `Grappa.Protocol.version/0` did not"

  @moduledoc """
  The gate behind the #1393d ruling: `Grappa.Protocol.version/0` bumps on
  EVERY wire-shape change, additive included.

  ## Why this is a separate task

  The obvious home for this rule is `mix grappa.gen_wire_types --check`, and
  it cannot host it. Measured on 2026-08-21, not assumed:

    * `--check` compares the REGENERATED artefact against the committed one,
      byte for byte (`verify_committed/2`). It touches no git and no network.
    * Add a field to a Wire typespec WITHOUT bumping the version, regenerate,
      and `--check` answers `in sync.` on both artefacts — green in exactly
      the case the rule exists to catch. It is not missing a condition; it is
      missing a BEFORE.

  Same shape as the reason `scripts/union-rebase.sh` is a VERB and not a
  check inside `design-notes-gate.sh`: a detector needs a before and an
  after, and a gate that only sees "now" has neither.

  ## The BEFORE, and why it is un-greenable

  `priv/wire/shape.pin` holds two facts TOGETHER: the digest of the
  generated wire shape, and the `Grappa.Protocol.version/0` it was taken at.
  Pairing them is the whole mechanism — `--update` REFUSES to rewrite the
  digest while the version stands still, so the only way to green a shape
  change is to bump the number, which is the rule.

  ⚠️ **Its own directory, and that is load-bearing, not tidiness.** `priv/`
  is NOT bind-mounted from a worktree — only `priv/repo` is, because `priv/`
  itself carries the SHARED `priv/plts` cache (`scripts/_lib.sh`). A pin
  written straight into `priv/` lands in the MAIN checkout, and a worktree
  run then reads a pin that belongs to no branch. Measured while building
  this: the first `--update` created the file in the main repo and the test
  suite went green against it. `priv/wire/` has its own override in
  `_lib.sh`, alongside the drift-pin inputs there for the same reason.

  ## The third component, and why a list could not be it (#2037)

  🔴 **Measured in this session, on this branch, not inherited:** a brand
  new field added to `GrappaWeb.MessagesJSON.count/1` — spec and body
  together — left `mix grappa.wire_pin --check` answering
  `wire shape and protocol 16 agree.` at rc 0, and
  `mix grappa.gen_wire_types --check` answering `in sync.` on the same
  tree, with the field appearing **0 times** in either generated artefact
  (positive control: 223 / 190 hits for a token that is in them; negative
  control 0). #2037 hit the same hole for real and the gate failed only on
  the VERSION field, printing a byte-identical digest across a two-field
  wire ADDITION.

  This is a RECURRENCE. #1679 met the class — `/boot` invisible to the
  tripwire — and cured it by adding one module to `gen_wire_types`'s
  hand-kept `@extra_modules` and writing a comment telling the next author
  to remember. The note did not hold, and it could not: the list is
  **fail-OPEN**, so forgetting it costs nothing and says nothing. (Issue
  2694 deleted the list: the codegen now takes the derived view set below.)

  Widening that list was not the cure either, measured at #2037: of the
  twelve `GrappaWeb.*JSON` views then, **eight declared no named `@type` at
  all** — `MessagesJSON` among them, which is where #2037's fields live. The
  codegen renders named types, so listing those modules bought exactly
  nothing. All twelve DID carry `@spec`s (29 of them). Issue 2694 named
  the inline envelopes, so today 13 views exist and 3 declare no `@type` of
  their own (Archive, Channels, Members), because every spec of theirs
  already returns a named `*.Wire` type, or a list of one.

  So the third component digests what the views **declare** — the
  `@spec`s of their EXPORTED functions, read from BEAM chunks, over a
  module set derived from the build output rather than typed by hand
  (`json_view_spec_text/0`). It is fail-CLOSED twice: a new view is
  covered the moment it compiles, and a discovery that finds nothing
  RAISES instead of contributing an empty string.

  The module set is `GenWireTypes.json_view_modules/0` — ONE membership
  rule, read by this gate and by the codegen alike (issue 2694). #2037 kept
  the views out of the codegen on purpose, because widening the runtime
  validator in `wireSchema.ts` is a client change and this was a gate
  change; issue 2694 is that client change, made deliberately, with its own
  protocol bump. The spec component stays even so: a view whose spec
  returns an inline map, with no named type behind it, is still invisible
  to the codegen, and the digest is what keeps that from passing silently.

  ⚠️ **Two limits, stated so they are not rediscovered as surprises.**
  A view whose BODY grows a key while its `@spec` stands still is still
  invisible here — Dialyzer is the leg that catches that one, and that is
  an ARGUMENT rather than something measured in this session. And a spec
  that references a remote type is digested as the reference TEXT, so a
  change INSIDE `Grappa.Scrollback.count_split()` moves nothing unless
  that type is in the digest's set by another route.

  The digest is taken over BOTH generated artefacts — `generate/0`
  (`wireTypes.ts`) and `generate_schema/0` (`wireSchema.ts`) — concatenated.
  Covering only the schema was the first design and it rested on an
  unmeasured claim; measured, NEITHER artefact carries typedoc prose (three
  header lines and section markers between them), so there was no
  false-positive argument for preferring one, and no evidence that the two
  can never move independently either. Digesting both removes the
  assumption: any change to what the codegen emits demands a bump, which
  under "bump it every time" is the intended behaviour rather than a cost.

  Reformatting a typespec — blank lines, a comment inside the map literal —
  leaves both byte-identical, so the gate does NOT false-positive on
  formatting. Measured, not reasoned: `wire_pin_test.exs` is the standing
  check, and the one-off experiment is in DESIGN_NOTES.

  Generated-NOW, never read from the committed artefact: a developer who
  edits a typespec and forgets to regenerate is caught here too, rather than
  only by the sibling drift gate.

  ## Changing what the digest COVERS

  Not a wire-shape change, and the gate cannot tell — it sees a moved digest
  and a still number, which is the violation. Hit while building this, when
  the digest was widened from one artefact to both: `--update` refused, and
  it was right to. The route is to DELETE the pin and re-create it, because
  a deleted tracked file is visible in review while a `--force` flag would
  be the hole the refusal exists to close. Do not add one.

  ## Cost, accepted knowingly

  The digest covers the WHOLE schema, so a shape change in an admin-only
  payload no client reads still demands a bump. Under "bump it every time"
  that is the correct behaviour and not a defect — but it is the recurring
  price, and it is named here rather than discovered.

  ## Offline by construction

  No git, no network, no subprocess. CI without a remote runs this
  identically; `wire_pin_test.exs` asserts that property on this file's own
  source rather than trusting this paragraph.

  ## Usage

      mix grappa.wire_pin --check     # the gate (scripts/check.sh, CI)
      mix grappa.wire_pin --update    # refresh the pin; refuses a bare digest bump

  There is no default mode on purpose. A bare invocation that silently
  rewrote the pin would be the one command that greens the gate by accident.
  """

  use Boundary, top_level?: true, deps: [Grappa.Protocol, Mix.Tasks.Grappa.GenWireTypes]

  use Mix.Task

  alias Mix.Tasks.Grappa.GenWireTypes

  @pin_path "priv/wire/shape.pin"
  @protocol_source "lib/grappa/protocol.ex"

  @version_re ~r/^protocol_version = (\d+)$/m
  @digest_re ~r/^shape_digest = (sha256:[0-9a-f]+)$/m

  @typedoc """
  The two facts the pin holds, together. Separately either one is a number
  nobody can falsify; paired, each is the other's witness.
  """
  @type pin :: %{protocol_version: pos_integer(), shape_digest: String.t()}

  @typedoc """
  `:shape_moved_without_bump` is the ruling's violation. `:pin_stale` is
  bookkeeping — the rule held, the file just has not caught up.
  """
  @type failure :: :shape_moved_without_bump | :pin_stale

  @impl Mix.Task
  @spec run([String.t()]) :: :ok
  def run(argv) do
    {opts, _, _} = OptionParser.parse(argv, switches: [check: :boolean, update: :boolean])
    Mix.Task.run("loadpaths")
    Mix.Task.run("compile")

    digest = shape_digest(shape_text())
    version = Grappa.Protocol.version()

    case {opts[:check], opts[:update]} do
      {true, _} -> do_check(digest, version)
      {_, true} -> do_update(digest, version)
      _ -> abort("mix grappa.wire_pin needs --check or --update (see `mix help #{Mix.Task.task_name(__MODULE__)}`)")
    end
  end

  @doc """
  The verdict, as a pure function of the three facts. Total over the four
  states: matched, the violation, and the two ways a pin goes stale.
  """
  @spec check(String.t(), pos_integer(), pin()) :: :ok | {:error, failure()}
  def check(digest, version, %{protocol_version: pinned_version, shape_digest: pinned_digest}) do
    cond do
      digest == pinned_digest and version == pinned_version -> :ok
      digest != pinned_digest and version == pinned_version -> {:error, :shape_moved_without_bump}
      true -> {:error, :pin_stale}
    end
  end

  @doc """
  Whether `--update` may rewrite the pin. False for exactly one state — the
  violation — because a refresh that could green it would delete the gate.
  """
  @spec updatable?(String.t(), pos_integer(), pin()) :: boolean()
  def updatable?(digest, version, pin) do
    check(digest, version, pin) != {:error, :shape_moved_without_bump}
  end

  @doc """
  What the developer reads. Names the constant, the file, both numbers and
  the command — a gate that only reports redness gets routed around.
  """
  @spec failure_message(failure(), String.t(), pos_integer(), pin()) :: String.t()
  def failure_message(:shape_moved_without_bump, digest, version, pin) do
    """
    The wire shape changed and the protocol version did not.

      shape digest   pinned #{pin.shape_digest}
                     now    #{digest}
      protocol       pinned #{pin.protocol_version}
                     now    #{version}   (unchanged)

    Since 2026-08-21 (#1393d) every wire-shape change bumps the number,
    additive fields included: additivity describes what the server EMITS and
    says nothing about what a client REQUIRES, and a floor that is not total
    is a floor that lies.

    Fix, in this order:

      1. edit @protocol_version in #{@protocol_source}: #{version} -> #{version + 1}
      2. run `mix grappa.wire_pin --update` to refresh #{@pin_path}
      3. commit both, and say in the message what moved on the wire

    If the shape change was NOT intended, that diff is the finding — a
    typespec moved that you did not mean to move.
    """
  end

  def failure_message(:pin_stale, digest, version, pin) do
    """
    #{@pin_path} is out of date. The rule held — nothing to argue about here.

      shape digest   pinned #{pin.shape_digest}
                     now    #{digest}
      protocol       pinned #{pin.protocol_version}
                     now    #{version}

    Run `mix grappa.wire_pin --update` and commit the result.
    """
  end

  @doc """
  Everything the wire shape is made of, as one string: what the codegen
  emits, plus what the hand-written web JSON views declare. Regenerated in
  memory, so a typespec edit that was never regenerated is caught here too.
  """
  @spec shape_text() :: String.t()
  def shape_text do
    GenWireTypes.generate() <>
      "\n" <> GenWireTypes.generate_schema() <> "\n" <> json_view_spec_text()
  end

  @doc """
  What the hand-written views DECLARE they return, as one deterministic
  string — module order sorted, spec order sorted, read from BEAM chunks so
  comments and formatting are invisible to it.

  The set is `GenWireTypes.json_view_modules/0`, which RAISES when
  discovery finds nothing. An empty contribution would be a silent
  fail-OPEN, which is the exact defect this component exists to remove: the
  digest would go on agreeing while covering one component fewer, and
  nothing would say so.
  """
  @spec json_view_spec_text() :: String.t()
  def json_view_spec_text do
    Enum.map_join(GenWireTypes.json_view_modules(), "\n", &render_view_specs/1)
  end

  defp render_view_specs(mod) do
    "// === #{inspect(mod)} ===\n" <> Enum.map_join(exported_specs(mod), "\n", &"  @spec #{&1}")
  end

  # EXPORTED only. A `@spec` on a private helper is not a wire shape, and
  # digesting it would redden the gate on a refactor that no client can see.
  defp exported_specs(mod) do
    with true <- Code.ensure_loaded?(mod),
         {:ok, specs} <- Code.Typespec.fetch_specs(mod) do
      exported = MapSet.new(mod.__info__(:functions))

      specs
      |> Enum.filter(fn {name_arity, _} -> MapSet.member?(exported, name_arity) end)
      |> Enum.flat_map(fn {{name, _}, forms} ->
        Enum.map(forms, &Macro.to_string(Code.Typespec.spec_to_quoted(name, &1)))
      end)
      |> Enum.sort()
    else
      _ -> []
    end
  end

  @doc """
  Digest of the generated wire shape. `sha256:` prefixed so the algorithm
  travels with the value and a future change of it is a visible diff.
  """
  @spec shape_digest(String.t()) :: String.t()
  def shape_digest(schema_text) do
    "sha256:" <> Base.encode16(:crypto.hash(:sha256, schema_text), case: :lower)
  end

  @doc "Serialise a pin. Line-oriented and hand-readable, so a review sees it."
  @spec render_pin(pin()) :: String.t()
  def render_pin(pin) do
    """
    # GENERATED by `mix grappa.wire_pin --update` — see that task's moduledoc.
    #
    # The two facts below belong together. `protocol_version` is the value of
    # `Grappa.Protocol.version/0` at the moment `shape_digest` was taken over
    # THREE components, concatenated: the two generated artefacts
    # (`wireTypes.ts` and `wireSchema.ts`) and the `@spec`s the hand-written
    # `GrappaWeb.*JSON` views export (#2037 — a field added to one of those
    # views moved neither artefact, and this gate said `agree.`). A shape
    # change with a still number is the violation the gate exists for, and
    # --update refuses to write it away.
    #
    # This line states the COVERAGE on purpose: widening or narrowing what
    # the digest spans is not a wire-shape change, the gate cannot tell one
    # from the other, and reading the pin is the only place a review sees it.
    protocol_version = #{pin.protocol_version}
    shape_digest = #{pin.shape_digest}
    """
  end

  @doc """
  Parse a pin. Both halves are required: a file missing one is an error, not
  a default, because a pin that reads as a default is a gate that passes on
  a file nobody wrote.
  """
  @spec parse_pin(String.t()) :: {:ok, pin()} | {:error, String.t()}
  def parse_pin(text) do
    with {:ok, version} <- capture(@version_re, text, "protocol_version = <integer>"),
         {:ok, digest} <- capture(@digest_re, text, "shape_digest = sha256:<hex>") do
      {:ok, %{protocol_version: String.to_integer(version), shape_digest: digest}}
    end
  end

  @doc "Read and parse the committed pin, raising on a missing or malformed file."
  @spec read_pin!() :: pin()
  def read_pin! do
    case File.read(@pin_path) do
      {:ok, text} -> unwrap_pin!(text)
      {:error, reason} -> raise "cannot read #{@pin_path}: #{:file.format_error(reason)}"
    end
  end

  defp unwrap_pin!(text) do
    case parse_pin(text) do
      {:ok, pin} -> pin
      {:error, message} -> raise "#{@pin_path} is malformed: #{message}"
    end
  end

  defp capture(regex, text, expected) do
    case Regex.run(regex, text) do
      [_, captured] -> {:ok, captured}
      nil -> {:error, "expected a line `#{expected}`"}
    end
  end

  defp do_check(digest, version) do
    pin = read_pin!()

    case check(digest, version, pin) do
      :ok ->
        Mix.shell().info("#{@pin_path}: wire shape and protocol #{version} agree.")

      {:error, failure} ->
        abort(failure_message(failure, digest, version, pin))
    end
  end

  defp do_update(digest, version) do
    if File.exists?(@pin_path) do
      refresh(digest, version, read_pin!())
    else
      write_pin(digest, version, "created")
    end
  end

  defp refresh(digest, version, pin) do
    if updatable?(digest, version, pin) do
      write_pin(digest, version, "updated")
    else
      abort(failure_message(:shape_moved_without_bump, digest, version, pin))
    end
  end

  defp write_pin(digest, version, verb) do
    File.write!(@pin_path, render_pin(%{protocol_version: version, shape_digest: digest}))
    Mix.shell().info("#{verb} #{@pin_path} — protocol #{version}, #{digest}")
  end

  # Declared `no_return()` because it is one: Dialyzer flags the missing
  # local return, and the constraint is right — every caller is a tail
  # position that must not continue. Silencing it by giving `abort/1` a
  # returning path would make a failed gate fall through into success.
  @spec abort(String.t()) :: no_return()
  defp abort(message) do
    Mix.shell().error(message)
    exit({:shutdown, 1})
  end
end
