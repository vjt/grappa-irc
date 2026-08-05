defmodule Grappa.Session.PerformList do
  @moduledoc """
  Pure module: expands a stored on-connect perform list (#189) into the
  executable wire lines, with `$nickserv_pass` / `$oper_pass` / `$nick`
  substituted.

  The perform list is **raw IRC**, one command per line — NOT cicchetto
  slash-commands and NOT user aliases (#385). cic owns only the editor
  panel; the server sends each expanded line verbatim (through
  `Grappa.Session.Server`'s outbound-capture path, so `NSInterceptor` still
  lifts any literal password for the `+r` staging). #288's Lua/Luerl engine
  — control flow, a scripting API, resource budgets — is explicitly out of
  scope; this is the static-command-list MVP preset.

  ## Skipped lines

  Blank lines and `#`-comment lines (leading `#`, after trimming) are
  dropped. No valid IRC command verb begins with `#`, so the marker is
  unambiguous. Each remaining line is trimmed of surrounding whitespace
  (incl. a trailing `\\r` from CRLF authoring).

  ## Variables

  Exactly three, substituted in a SINGLE pass so a bound value that happens
  to contain a `$…` token is never re-expanded:

    * `$nickserv_pass` — the credential's stored upstream NickServ password.
    * `$oper_pass` — the sibling `oper_pass` secret field.
    * `$nick` (#885) — the credential's CONFIGURED nick, NOT the nick the
      session currently holds. That is the whole point: when the primary
      nick was taken and we landed on `vjt_`,
      `NS IDENTIFY $nick $nickserv_pass` must still name `vjt` — binding the
      live nick would expand to exactly the value that does not identify.
      The caller (`Grappa.Session.Server`'s `configured_nick/1`) owns that
      distinction.

  A variable with no bound value expands to the empty string (never the
  literal token — leaking `$nickserv_pass` onto the wire as a password would
  be worse than an empty one). Only these three tokens are variables; other
  `$…` sequences (e.g. `$realname`) pass through verbatim.

  `nick` is a PREFIX — of `nickserv_pass` and of ordinary words alike — so it
  carries a trailing `\\b`. That boundary is the ONE load-bearing guard, and it
  covers both cases: `$nickname` stays verbatim instead of becoming `vjtname`,
  and `$nickserv_pass` still reaches the password branch (at `$nickserv_pass`
  the `nick\\b` branch fails on `k`→`s`, both word characters, so alternation
  falls through). It sits INSIDE the group, on that branch alone, so the two
  pre-existing tokens keep their exact previous matching behaviour rather than
  newly refusing to match e.g. `$nickserv_passX`.

  `nick` is nonetheless placed LAST. Measured, that placement changes nothing
  while the `\\b` is there — it is the second line of defence for the day
  someone deletes the boundary, since alternation is leftmost-first rather
  than longest-match and `nick` first WITHOUT the boundary expands
  `$nickserv_pass` to the nick plus a literal `serv_pass` tail, silently
  keeping the password off the wire. Do not read the order as the guard: the
  tests pin the outcomes, and only removing the `\\b` turns them red.

  ## Secrecy

  `$nick` is not a secret, but the EXPANDED lines still are: any line may
  carry a password (a substituted one, or a literal the user pasted). The
  redaction contract on `t:result/0` is therefore unchanged, and so is
  `consumed_nickserv_pass?`, which stays keyed on the NickServ password
  alone — using `$nick` never suppresses the built-in identify.

  ## Suppression signal (`consumed_nickserv_pass?`)

  `true` iff an EXECUTED (non-comment, non-blank) line actually substituted
  a present NickServ password. This is the exact structural signal
  `Grappa.Session.Server` uses to skip its built-in identify — NOT a text
  scan for `identify`/`ns id` verbs, which the codebase deliberately rejects
  (`NSInterceptor` moduledoc). A `$nickserv_pass` sitting in a COMMENTED-OUT
  line does not count: it was never executed.

  Boundary: inherits the parent `Grappa.Session` boundary (no `use
  Boundary`), same as `Grappa.Session.NSInterceptor`.
  """

  @typedoc """
  The variable bindings. Two are secrets, `nick` is not (see "Secrecy") — so
  the map is named for what it actually is, a binding set, rather than
  inviting a reader to treat every value in it as a password.
  """
  @type bindings :: %{
          required(:nickserv_pass) => String.t() | nil,
          required(:oper_pass) => String.t() | nil,
          required(:nick) => String.t() | nil
        }

  @typedoc """
  `lines` are the executable wire lines, in order, with secrets already
  substituted — so they are NEVER safe to log (a line may carry a literal
  password the user pasted instead of a variable). The caller logs a
  redaction: the line COUNT and total byte size, never the text.
  """
  @type result :: %{lines: [String.t()], consumed_nickserv_pass?: boolean()}

  # All three variable tokens in ONE alternation → single-pass Regex.replace,
  # so a substituted value containing `$…` is never re-scanned. The `nick\b`
  # boundary is load-bearing (the branch order is not, while it stands) —
  # see the moduledoc.
  @var_re ~r/\$(nickserv_pass|oper_pass|nick\b)/
  @nickserv_var "$nickserv_pass"

  @doc """
  Expands `text` against `bindings`. Returns the executable lines (in order)
  and the `consumed_nickserv_pass?` suppression signal. `nil`/blank text
  yields no lines.
  """
  @spec expand(String.t() | nil, bindings()) :: result()
  def expand(nil, _), do: %{lines: [], consumed_nickserv_pass?: false}

  def expand(text, bindings) when is_binary(text) do
    parsed =
      text
      |> String.split(~r/\r\n|\r|\n/)
      |> Enum.map(&String.trim/1)
      |> Enum.reject(&skip_line?/1)
      |> Enum.map(&expand_line(&1, bindings))

    %{
      lines: Enum.map(parsed, & &1.line),
      consumed_nickserv_pass?: Enum.any?(parsed, & &1.consumed?)
    }
  end

  @spec skip_line?(String.t()) :: boolean()
  defp skip_line?(""), do: true
  defp skip_line?("#" <> _), do: true
  defp skip_line?(_), do: false

  defp expand_line(line, bindings) do
    %{
      line: Regex.replace(@var_re, line, fn _, var -> value_for(var, bindings) end),
      consumed?: String.contains?(line, @nickserv_var) and is_binary(bindings[:nickserv_pass])
    }
  end

  defp value_for("nickserv_pass", bindings), do: bindings[:nickserv_pass] || ""
  defp value_for("oper_pass", bindings), do: bindings[:oper_pass] || ""
  defp value_for("nick", bindings), do: bindings[:nick] || ""
end
