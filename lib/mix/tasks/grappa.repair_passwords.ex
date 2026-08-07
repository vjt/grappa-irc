defmodule Mix.Tasks.Grappa.RepairPasswords do
  @shortdoc "Repairs credentials whose stored password #977 concatenated; dry-run unless --write"

  @moduledoc """
  Operator sweep for the credentials #977 corrupted, and a standing check
  that no new one has appeared.

  ## Usage

      scripts/mix.sh grappa.repair_passwords            # dry run — reports, writes nothing
      scripts/mix.sh grappa.repair_passwords --write    # applies the deterministic repairs

  ## What went wrong

  Before #983, the in-session `SET PASSWD <old> <new>` capture stored the
  whole rest of the line, so the credential ended up holding `"<old> <new>"` —
  the two passwords joined by the space `do_set_password` splits on
  (`azzurra/services src/nickserv.c`). #983 stopped the bleeding and #124 gave
  the subject a field to retype their own password in, but neither backfills a
  row that is already wrong. This task is that backfill.

  ## Why the space is an exact signature, and where it stops being one

  An Azzurra password cannot contain a space: `do_set_password` and
  `do_resetpass` refuse `strchr(newpass, ' ')` outright. So for a secret that
  Azzurra's NickServ governs, a stored space is a concatenation artifact with
  certainty — not a heuristic, and with no false positives.

  That certainty does NOT extend to the whole column. After #124's fold
  (`20260807120000_fold_nickserv_pass_onto_password`), `password_encrypted` is
  the single home for the NickServ secret AND the SASL one AND the server
  password. SASL PLAIN base64-encodes its passphrase
  (`Grappa.IRC.AuthFSM`), so a space there is legitimate and identifies
  normally; `Credential.password_changeset/2` guards only CR/LF/NUL, and
  `Credentials.update_credential_password/2` applies Azzurra's chain only when
  the method is `:nickserv_identify`. Reading a space on a `:sasl` row as
  corruption and "repairing" it would truncate a live passphrase to its last
  token — Cloak AES-GCM, no plaintext backup, nothing to reverse it from.

  So the space decides only where Azzurra's rule actually governs the secret.
  Everywhere else the answer is the verb this task already owes the >2-token
  case: report it, and let a human decide.

  ## The rule that governs every judgement call here

  **A missed repair costs a manual intervention. A wrong repair costs an
  unrecoverable secret. The two do not weigh the same.** Any remaining doubt
  in this task resolves to *report*, never to *guess*.

  ## The detector is borrowed, not re-derived

  `Session.NSInterceptor.vet_password/2` is already public as the "second
  door" #124 needed, and its spaces arm is FIRST in the chain — no later arm
  can shadow it, which is what makes the call an exact test rather than an
  approximation. The same call supplies the `PASSMAX` verdict, so `32` is not
  hard-coded a second time and cannot drift from the wire door.

  ## Why the task stays in the tree

  It is idempotent and inert on a healthy database: it prints `0 candidates`
  and writes nothing. It is an operator tool, not a one-shot migration.
  Its standing value is the inverse reading — with #983 holding the capture
  and #124 offering the cure, nothing should be able to produce a corrupted
  credential any more, so a run that DOES find one is the signal of a new
  bug rather than routine maintenance. The output says so.

  The retired `nickserv_pass_encrypted` column is never read and never
  written: it was never fed by the `SET PASSWD` capture path, so it is not
  part of this corruption.
  """
  use Boundary,
    top_level?: true,
    deps: [Grappa.Networks, Grappa.Session, Mix.Tasks.Grappa.Boot]

  use Mix.Task

  alias Grappa.Networks.{Credential, Credentials}
  alias Grappa.Session.NSInterceptor
  alias Mix.Tasks.Grappa.Boot

  @switches [write: :boolean]

  @typedoc """
  Why a row is reported instead of repaired. Every one of these means the
  live password cannot be derived from what is stored — a human has to
  supply it.
  """
  @type report_reason ::
          :ambiguous_auth_method
          | :multiple_rotations
          | {:unusable, NSInterceptor.vet_reject_reason()}
          | {:unusable_repair, NSInterceptor.vet_reject_reason()}

  @typedoc """
  What the concatenation branch can conclude. Narrower than
  `classification/0` on purpose: once a stored value has been found to hold
  a space there is something to say about it, so `:healthy` and
  `:no_password` are no longer reachable — Dialyzer proves it, and the
  split type records the decision tree instead of hiding it behind one
  catch-all.
  """
  @type verdict :: {:repairable, String.t()} | {:report, report_reason()}

  @type classification :: :no_password | :healthy | verdict()

  @doc """
  Classifies one credential's stored password. Pure — reads the struct, hits
  no database, decides nothing about writing.

  `{:repairable, password}` carries the value that WOULD be written; every
  other result writes nothing.
  """
  @spec classify(Credential.t()) :: classification()
  def classify(%Credential{password_encrypted: nil}), do: :no_password

  def classify(%Credential{password_encrypted: password, nick: nick, auth_method: auth_method}) do
    # The nick column is nullable; an empty one only makes the chain's
    # "password equals your nick" arm inert, exactly as in
    # `Credentials.vet_nickserv_password/3`.
    case NSInterceptor.vet_password(password, nick || "") do
      {:error, :password_with_spaces} -> classify_concatenation(password, nick, auth_method)
      {:error, reason} -> classify_unusable(reason, auth_method)
      :ok -> :healthy
    end
  end

  # Split on a LITERAL single space with no `trim:`, mirroring what services
  # do rather than what looks tidy. A run of spaces, a leading one or a
  # trailing one all yield an extra empty token and land in
  # `:multiple_rotations` — which is the correct answer, not an accident of
  # the split: `do_set_password` cuts at the FIRST space and then refuses a
  # `newpass` that still holds one, so such a rotation never took upstream
  # and NEITHER token is known to be the live password.
  @spec classify_concatenation(String.t(), String.t() | nil, Credential.auth_method()) :: verdict()
  defp classify_concatenation(password, nick, :nickserv_identify) do
    case String.split(password, " ") do
      # Exactly two tokens is the single-rotation case, and it is the only
      # deterministic one. "Keep the LAST token" and "keep the second" agree
      # here by construction — which is precisely why >2 is reported instead:
      # at three tokens the two rules diverge and only the operator knows
      # which rotation is live.
      [_, new] -> classify_repair(new, nick)
      _ -> {:report, :multiple_rotations}
    end
  end

  defp classify_concatenation(_, _, _), do: {:report, :ambiguous_auth_method}

  # A repair that services would themselves refuse is not a repair — it just
  # exchanges one silently-never-identifying value for another.
  @spec classify_repair(String.t(), String.t() | nil) ::
          {:repairable, String.t()} | {:report, {:unusable_repair, NSInterceptor.vet_reject_reason()}}
  defp classify_repair(candidate, nick) do
    case NSInterceptor.vet_password(candidate, nick || "") do
      :ok -> {:repairable, candidate}
      {:error, reason} -> {:report, {:unusable_repair, reason}}
    end
  end

  # Azzurra's guard chain judges only a secret spoken to Azzurra's NickServ.
  # A SASL or server password is not, and its 32-byte cap has no business
  # calling a legitimately longer one unusable — the same scoping
  # `Credentials.update_credential_password/2` applies at the #124 door.
  @spec classify_unusable(NSInterceptor.vet_reject_reason(), Credential.auth_method()) ::
          :healthy | {:report, {:unusable, NSInterceptor.vet_reject_reason()}}
  defp classify_unusable(reason, :nickserv_identify), do: {:report, {:unusable, reason}}
  defp classify_unusable(_, _), do: :healthy

  @impl Mix.Task
  def run(args) do
    {opts, _, _} = OptionParser.parse(args, strict: @switches)
    # Dry run is the default, and the default is the safe direction: writing
    # is the irreversible half, so it is the half that has to be asked for.
    write? = Keyword.get(opts, :write, false)

    Boot.start_app_silent()

    classified = Enum.map(Credentials.list_credentials_every_subject(), &{&1, classify(&1)})

    repairable = for {credential, {:repairable, new}} <- classified, do: {credential, new}
    reported = for {credential, {:report, reason}} <- classified, do: {credential, reason}

    print_scan(classified, repairable, reported)
    print_rows("reported — nothing written, a human decides:", reported, &describe_reason/1)
    print_rows("repairable:", repairable, fn _ -> "one rotation — would keep the last token" end)

    finish(write?, repairable, reported)
  end

  @spec print_scan([{Credential.t(), classification()}], list(), list()) :: :ok
  defp print_scan(classified, repairable, reported) do
    blank = Enum.count(classified, &match?({_, :no_password}, &1))

    IO.puts("scanned #{length(classified)} credentials, every subject (#{blank} carry no stored password)")
    IO.puts("  #{length(repairable)} repairable")
    IO.puts("  #{length(reported)} reported")

    if repairable == [] and reported == [], do: IO.puts("0 candidates — nothing to repair."), else: :ok
  end

  @spec print_rows(String.t(), [{Credential.t(), term()}], (term() -> String.t())) :: :ok
  defp print_rows(_, [], _), do: :ok

  defp print_rows(heading, rows, describe) do
    IO.puts("")
    IO.puts(heading)
    # NEVER the password, nor any token of it, nor its length: this output
    # goes to an operator's terminal and, from there, to scrollback and
    # pastebins. The row identity plus the reason is all that is needed to
    # act on it.
    Enum.each(rows, fn {credential, detail} ->
      IO.puts("  #{label(credential)}: #{describe.(detail)}")
    end)
  end

  @spec label(Credential.t()) :: String.t()
  defp label(%Credential{} = credential) do
    "##{credential.id} (#{subject(credential)} #{credential.nick} @#{credential.network.slug}, #{credential.auth_method})"
  end

  @spec subject(Credential.t()) :: String.t()
  defp subject(%Credential{user_id: nil}), do: "visitor"
  defp subject(%Credential{}), do: "user"

  @spec describe_reason(report_reason()) :: String.t()
  defp describe_reason(:ambiguous_auth_method),
    do: "holds a space, but this method's secret may legitimately contain one — not decidable from here"

  defp describe_reason(:multiple_rotations),
    do: "more than one rotation is concatenated here — which one is live is not derivable"

  defp describe_reason({:unusable, reason}),
    do: "space-free, but services would refuse it (#{reason}) — it can never identify as stored"

  defp describe_reason({:unusable_repair, reason}),
    do: "one rotation, but the recovered password would itself be refused (#{reason})"

  @spec finish(boolean(), [{Credential.t(), String.t()}], list()) :: :ok
  defp finish(_, [], []), do: :ok

  defp finish(false, repairable, _) do
    new_bug_note()
    IO.puts("")
    IO.puts("DRY RUN — nothing written. Re-run with --write to apply the #{length(repairable)} repair(s) above.")
  end

  defp finish(true, repairable, _) do
    new_bug_note()
    IO.puts("")
    Enum.each(repairable, &apply_repair/1)
    IO.puts("repaired #{length(repairable)} credential(s).")
  end

  # Printed whenever anything at all turned up, repairable or not: after #983
  # closed the capture and #124 opened the cure, a fresh candidate is not
  # backlog being worked off.
  @spec new_bug_note() :: :ok
  defp new_bug_note do
    IO.puts("")

    IO.puts(
      "NOTE: #983 stopped the capture concatenating and #124 lets the subject retype their own\n" <>
        "password, so no credential should be able to become corrupted any more. A candidate found\n" <>
        "here is the signal of a NEW bug, not routine maintenance — investigate before repairing."
    )
  end

  # The repair goes through the #124 door itself, not a hand-rolled update:
  # `update_credential_password/2` re-encrypts through
  # `Credential.password_changeset/2` and re-runs Azzurra's chain, so the
  # sweep writes exactly what a subject retyping the value into Settings ->
  # General would. A failure is printed, never swallowed.
  @spec apply_repair({Credential.t(), String.t()}) :: :ok
  defp apply_repair({credential, new_password}) do
    case Credentials.update_credential_password(credential, new_password) do
      {:ok, _} ->
        IO.puts("  repaired #{label(credential)}")

      {:error, reason} ->
        IO.puts(:stderr, "  FAILED #{label(credential)}: #{inspect(reason)}")
    end
  end
end
