defmodule Grappa.Session.NSInterceptor do
  @moduledoc """
  Pure module: matches an outbound IRC wire line for any NickServ-account
  identify verb that carries a password, and lifts the password out for the
  host (`Grappa.Session.Server`) to stage or commit. The result carries a
  `kind` (`:identify | :register | :set_passwd`) so the host can pick the
  right action: IDENTIFY-family captures stage the TIMED `pending_auth`;
  REGISTER captures stage the UNTIMED `pending_registration_secret` (#129 —
  register grants +r minutes-to-hours later, outside the 10s window);
  SET PASSWD captures are committed OPTIMISTICALLY on-send (#131 — an
  already-identified session rotating its password emits no `+r`, so there
  is no rendezvous to stage against). Staged captures are committed to the
  visitor row ONLY on +r MODE observation (the timed slot is also discarded
  on the `@pending_auth_timeout_ms` timeout). Wrong passwords never touch
  the DB; a rejected SET PASSWD leaves a stored password that never took,
  which the operator repairs by retyping it into the per-network password field (#124, Settings -> General).

  Covers the full azzurra identify-channel set (source-verified against
  `bahamut-azzurra` ircd + azzurra `services`):

    * `PRIVMSG NickServ[@host] :IDENTIFY|ID|SIDENTIFY|GHOST|REGISTER <args>`
    * `NS|NICKSERV IDENTIFY|ID|SIDENTIFY|GHOST|REGISTER <args>`   (services command alias)
    * `IDENTIFY|ID|SIDENTIFY <args>`                    (ircd `m_identify`)
    * `PASS <args>`                                     (ircd `m_pass` -> `m_identify`, post-connect)
    * `PRIVMSG NickServ[@host] :SET PASSWD <old> <new>` / `NS|NICKSERV SET PASSWD <old> <new>` /
      bare `SET PASSWD <old> <new>`                      (#131 — in-session password change)
    * `PRIVMSG NickServ[@host] :RESETPASS <nick> <code> <new>` /
      `NS|NICKSERV RESETPASS <nick> <code> <new>`        (#978 — account recovery)

  Every pattern is ANCHORED at line start (`^`) so a channel PRIVMSG body that
  merely CONTAINS "identify"/"pass"/"set passwd"/"resetpass" is never captured — raw IRC
  frames start with the command verb, PRIVMSGs start with `PRIVMSG`.

  Password extraction: for IDENTIFY/ID/SIDENTIFY/PASS the lone token, or the
  SECOND of two or more (`IDENTIFY [account] <pass>`, `PASS [nick] <pass>` —
  services read two tokens and never a third); for GHOST the SECOND token, and
  NOTHING when the nick stands alone (`GHOST <nick> <pass>`, issue 2318);
  FIRST token for REGISTER (`REGISTER <pass> <email>`); the SECOND token for
  SET PASSWD (#977); the THIRD for RESETPASS (#978). The Azzurra verb is
  `SET PASSWD`, NOT `SET PASSWORD`
  (`do_set` only routes `PASSWD`; `PASSWORD` errors), so the regex matches
  `PASSWD` exactly and lets `SET PASSWORD …` fall through untouched.

  ## SET PASSWD takes the OLD password first, and its new one has no spaces

  Read off `azzurra/services@23473ed`, not inferred. `do_set`
  (`src/nickserv.c:2090`) hands the handler `param = strtok(NULL, "")` —
  everything after the verb — and `do_set_password` (`:2182`) then splits
  THAT at the first space: `newpass = strchr(param, ' '); *newpass++ = 0;`.
  The head is the OLD password (`:2204`: *"param holds the old password"*,
  checked against the stored one), the tail is the new. The form is
  `SET PASSWD <old> <new>` and the rotation is AUTHENTICATED.

  Before #977 this module read that `strtok(NULL, "")` as "the new password,
  which may therefore contain spaces" and captured rest-of-line — so every
  in-session rotation stored `"<old> <new>"` concatenated and corrupted the
  credential. Azzurra passwords cannot contain spaces AT ALL: right after the
  split, `strchr(newpass, ' ')` earns `CSNS_ERROR_PASSWORD_WITH_SPACES`.

  Since the capture is written to the credential OPTIMISTICALLY on-send, a
  value services would refuse must never be captured — it would store a
  secret that never took. So this module also carries `do_set_password`'s own
  guard chain, in its order (spaces / nick-or-under-5 / over-`PASSMAX` /
  control codes), and answers `{:reject, :set_passwd, reason}` with the
  services error constant as the reason. The line still goes out: services
  send the user their own error notice, and grappa's DB stays untouched.
  `PASSMAX` = 32 is a compile-time `#define` (`inc/config.h:96`), NOT a
  services.conf directive — there is nothing to learn at runtime and nothing
  for an operator to tune, so it lives here as a constant with its source
  reference.

  Two `do_set_password` guards are deliberately NOT mirrored: `str_equals`
  against the CURRENT password (rejecting a no-op rotation, which would store
  the value already stored — no divergence either way) and the old-password
  check itself (`str_equals(param, ni->pass)`; grappa cannot vet a wrong OLD
  password from the line alone, so a mistyped one still commits optimistically
  — repaired by retyping it into the per-network password field (#124, Settings -> General), unchanged by #977).

  ## RESETPASS: the THIRD token, and it names the account (#978)

  Read off `azzurra/services@23473ed`, `src/nickserv.c:3851` (`do_resetpass`),
  not inferred. The handler pulls three `strtok(NULL, " ")` in order — nick,
  code, new password — so the secret is the third TOKEN, a fourth is never
  read (services DISCARD anything after it), and runs of spaces collapse the
  way `strtok` skips its delimiters. There is no `RESETPASS` in the ircd's
  message table (`azzurra/bahamut include/msg.h` carries `IDENTIFY` and
  `PASS`, no `RESETPASS`), so — unlike IDENTIFY/SET PASSWD — a BARE
  `RESETPASS …` reaches no service and must not be captured.

  The capture carries the TARGET NICK alongside the password, because
  RESETPASS is the one verb here that names the account it rotates: it can
  recover a nick that is not this session's. Whether that account is the one
  this session's credential holds is the host's call (`Session.Server`, which
  owns `configured_nick/1` and the casemapping-aware fold), so this module
  reports both operands and judges neither.

  ### It commits on-send and CANNOT stage against `+r`

  `do_resetpass` ends with `user_remove_id(ni->nick, FALSE)` (`:3948`): a
  SUCCESSFUL reset drops every current identification instead of granting
  one. No `+r` follows, ever — so the `:identify` family's rendezvous is not
  merely inconvenient here, it is structurally unreachable, and a staged
  capture would wait for a confirmation that cannot arrive. RESETPASS
  therefore commits optimistically on-send, like `:set_passwd` (#131).

  ### Which guards are mirrored, and which cannot be

  Since the commit is optimistic, a value services would refuse must never be
  captured. `do_resetpass` (`:3917`-`:3934`) applies the SAME four password
  guards as `do_set_password`, against the same constants, so both verbs run
  one shared `vet_new_password/3` — spaces / nick-or-under-5 /
  over-`PASSMAX` / control codes — answered as
  `{:reject, :reset_passwd, reason}` with the services error constant as the
  reason. The line still goes out; services notify the user.

  Only the nick differs: `do_set_password` compares the new password against
  `callerUser->nick`, `do_resetpass` against `ni->nick` — the nick being
  RESET, which the line itself carries. And the shared spaces arm is dead on
  this path, exactly as `do_resetpass`'s own `strchr(newpass, ' ')` is dead
  upstream: `strtok(" ")` already ended the token at the first space.

  Everything `do_resetpass` checks BEFORE the password — nick registered, not
  forbidden, not frozen, `NI_PASSRESET` set, the code within `ONE_WEEK` of the
  SENDPASS, and the code matching `ni->auth` — is services-side state this
  module cannot see, so a doomed RESETPASS still commits optimistically
  (repaired by retyping the password into the per-network password field (#124, Settings -> General)). The code is deliberately not vetted
  even for shape: `strtoul(codestr, &err, 10)` accepts a leading sign, so a
  partial mirror would reject lines services accept — and a false reject
  silently reinstates the very bug #978 closes, while a false accept only
  re-enters a divergence that is already accepted here.

  A reject reason is therefore the notice the user receives only when those
  earlier checks passed; it is a log-line detail, never a claim about what
  services did.

  Boundary: inherits the parent `Grappa.Session` boundary (no `use Boundary`).
  """

  alias Grappa.IRC.Identifier

  @typedoc """
  The captured verb's class. `:identify` covers IDENTIFY/ID/SIDENTIFY/
  GHOST/PASS — services grant +r synchronously (within the 10s window),
  so the host stages a TIMED `pending_auth`. `:register` is the
  register→auth-code flow (#129): services email an auth code and grant
  +r minutes-to-hours later, far outside that window, so the host stages
  an UNTIMED `pending_registration_secret`. `:set_passwd` is the
  in-session password change (#131): an already-identified session
  rotates its NickServ password, which emits NO `+r` transition — so the
  host commits it OPTIMISTICALLY on-send rather than staging it against a
  rendezvous. `:reset_passwd` (#978) is the account-recovery sibling: it
  commits on-send for a STRONGER reason — a successful RESETPASS
  de-identifies the user, so no `+r` can ever follow — and it is the only
  kind whose capture carries a second operand, the nick it rotates. The
  host maps verb → action; the interceptor only reports which verb it saw.
  """
  @type kind :: :identify | :register | :set_passwd | :reset_passwd

  @typedoc """
  The two verbs that ROTATE a stored secret rather than prove one. They are
  the only kinds that can be REJECTED — an optimistic on-send commit has no
  take-backs, so a value services would refuse must be caught here, while a
  wrong IDENTIFY password simply never reaches the DB.
  """
  @type rotation_kind :: :set_passwd | :reset_passwd

  @typedoc """
  Why a syntactically-matched rotation verb was NOT captured: the name of the
  services error the line will earn (`do_set_password` / `do_resetpass`,
  `src/nickserv.c`) — for RESETPASS, if it gets that far. `:syntax_error` is
  the one-token `SET PASSWD <new>` form and the under-three-tokens RESETPASS,
  both refused outright — services change nothing, so neither may we. It is
  raised while PARSING, which is why it is not a `vet_reject_reason/0`: the
  shared guard chain only ever sees a line that already tokenised.
  """
  @type reject_reason :: :syntax_error | vet_reject_reason()

  @typedoc """
  The four guards `do_set_password` and `do_resetpass` share, verbatim.
  `:password_with_spaces` cannot arise on the RESETPASS path: `strtok(" ")`
  ends the token at the first space, so its third token can never hold one.
  """
  @type vet_reject_reason ::
          :password_with_spaces
          | :insecure_password
          | :password_max_length
          | :password_with_ccodes

  @type result ::
          :passthrough
          | {:capture, kind(), String.t()}
          | {:capture, :reset_passwd, String.t(), String.t()}
          | {:reject, rotation_kind(), reject_reason()}

  # `azzurra/services@23473ed inc/config.h:96` — `#define PASSMAX 32`, and
  # both handlers reject under 5. Compile-time defines, not conf knobs.
  @passmax 32
  @passmin 5

  # PRIVMSG-to-NickServ / NS-NICKSERV command form. `(?:...)` groups are
  # non-capturing; capture groups are (verb, rest).
  @verb_re ~r/^(?:PRIVMSG\s+NickServ(?:@\S+)?\s+:|(?:NS|NICKSERV)\s+)(IDENTIFY|ID|SIDENTIFY|GHOST|REGISTER)\s+(\S.*?)\s*$/i

  # Bare ircd command form (m_identify).
  @bare_re ~r/^(IDENTIFY|ID|SIDENTIFY)\s+(\S.*?)\s*$/i

  # PASS post-connect identify (m_pass -> m_identify).
  @pass_re ~r/^PASS\s+(\S.*?)\s*$/i

  # #131 / #977 — in-session SET PASSWD. Same anchored PRIVMSG-NickServ /
  # NS-NICKSERV prefix family as `@verb_re`, plus the bare form (raw `/quote
  # SET PASSWD`), via an optional prefix group. The verb is the literal
  # two-token `SET PASSWD` (Azzurra `do_set` only routes `PASSWD`; `PASSWORD`
  # errors — the literal `PASSWD` followed by a space or EOL rejects
  # `PASSWORD …`).
  #
  # The capture group is services' `param` — old AND new, VERBATIM, split
  # here rather than by the regex. No trimming: services trim nothing, and a
  # trailing space is precisely what makes them refuse the line. Separators
  # from `SET` onward are LITERAL spaces, not `\s`, because services tokenise
  # with `strtok(…, " ")` / `strchr(…, ' ')` — a TAB is not a delimiter there
  # and must not be treated as one. The PRIVMSG prefix keeps `\s+`: that part
  # is parsed by the ircd, not by services. The group is optional so a bare
  # `SET PASSWD` reaches the same `:syntax_error` verdict as `SET PASSWD x`.
  @set_passwd_re ~r/^(?:PRIVMSG\s+NickServ(?:@\S+)?\s+:|(?:NS|NICKSERV)\s+)?SET +PASSWD(?: (.*))?$/i

  # #978 — account-recovery RESETPASS. Same PRIVMSG-NickServ / NS-NICKSERV
  # prefix family as `@verb_re`, but the prefix is NOT optional: RESETPASS is
  # a services command with no ircd counterpart, so a bare line reaches
  # nobody. The single group is services' argument string, VERBATIM and
  # untrimmed — `split_resetpass/1` tokenises it the way `strtok(NULL, " ")`
  # does, which is why the separator here is a LITERAL space rather than
  # `\s`: a TAB is not a delimiter to services and must not become one here.
  # The PRIVMSG prefix keeps `\s+` — that part is parsed by the ircd. The
  # group is optional so a bare `RESETPASS` reaches the same `:syntax_error`
  # verdict as `RESETPASS vjt`.
  @resetpass_re ~r/^(?:PRIVMSG\s+NickServ(?:@\S+)?\s+:|(?:NS|NICKSERV)\s+)RESETPASS(?: (.*))?$/i

  @doc """
  Inspects one outbound IRC wire line and returns `:passthrough` (no NickServ
  secret-bearing verb detected), `{:capture, kind, password}` with the
  cleartext password lifted out and the verb class (`:identify` / `:register`
  / `:set_passwd`) for the host to act on,
  `{:capture, :reset_passwd, target_nick, password}` for the one verb that
  also names the account it rotates (#978), or `{:reject, kind, reason}` for
  a rotation services will refuse (#977, #978).

  `nick` is the sender's CURRENT nick — `callerUser->nick` on the services
  side. `do_set_password` refuses a new password equal to it
  (`str_equals_nocase`), and this module refuses the same, so the nick is an
  input to the verdict rather than something the host re-checks afterwards.
  It is NOT used on the RESETPASS path: `do_resetpass` compares against the
  nick being RESET (`ni->nick`), which the line itself carries.

  Pure: no side effects. The host (`Grappa.Session.Server`) decides whether
  to stage against `+r` MODE (`:identify`/`:register`), commit optimistically
  on-send (`:set_passwd`, #131; `:reset_passwd`, #978 — and for the latter,
  only when the target nick is this session's own account), discard on the
  pending-auth timeout, or overwrite on a subsequent capture.
  """
  @spec intercept(String.t(), String.t()) :: result()
  def intercept(line, nick) when is_binary(line) and is_binary(nick) do
    case Regex.run(@verb_re, line, capture: :all_but_first) do
      [verb, rest] -> dispatch(String.upcase(verb), rest)
      nil -> intercept_resetpass(line, nick)
    end
  end

  # #978 — RESETPASS. Shares no verb with its siblings, so this check is
  # order-independent w.r.t. `@verb_re`/`@set_passwd_re`/`@bare_re`/`@pass_re`.
  defp intercept_resetpass(line, nick) do
    case Regex.run(@resetpass_re, line, capture: :all_but_first) do
      # `:re` TRIMS an unset trailing group, so a bare `RESETPASS` — verb and
      # nothing else — arrives as `[]` rather than `[""]`.
      [] -> {:reject, :reset_passwd, :syntax_error}
      [args] -> split_resetpass(args)
      nil -> intercept_set_passwd(line, nick)
    end
  end

  # Three `strtok(NULL, " ")` in a row: runs of spaces are skipped, empty
  # tokens are never produced, and the third token ENDS at the next space —
  # so a fourth is unread and the password cannot contain a space. Missing
  # any of the three is NS_RESETPASS_SYNTAX_ERROR: services change nothing,
  # so neither may we. The nick vetted against is the line's own first token
  # (`ni->nick`), NOT the caller's — `do_resetpass` can reset another nick.
  defp split_resetpass(args) do
    # nick, code (services' to check), new password, then the discarded tail.
    case String.split(args, " ", trim: true) do
      [nick, _, new_password | _] ->
        case vet_new_password(:reset_passwd, new_password, nick) do
          :ok -> {:capture, :reset_passwd, nick, new_password}
          reject -> reject
        end

      _ ->
        {:reject, :reset_passwd, :syntax_error}
    end
  end

  # #131 / #977 — SET PASSWD. SET PASSWD shares no verb with the identify
  # family, so this check is order-independent w.r.t.
  # `@verb_re`/`@bare_re`/`@pass_re`.
  defp intercept_set_passwd(line, nick) do
    case Regex.run(@set_passwd_re, line, capture: :all_but_first) do
      # `:re` TRIMS an unset trailing group, so a bare `SET PASSWD` — verb and
      # nothing else — arrives as `[]` rather than `[""]`.
      [] -> {:reject, :set_passwd, :syntax_error}
      [param] -> split_set_passwd(param, nick)
      nil -> intercept_bare(line)
    end
  end

  # `param` is services' `strtok(NULL, "")`: OLD password, then new. The
  # split is at the FIRST space, exactly like `strchr(param, ' ')`; with no
  # space at all `do_set_password` bails to NS_SET_PASSWD_SYNTAX_ERROR, so a
  # one-token `SET PASSWD <new>` (the Atheme spelling) changes nothing
  # upstream and must change nothing here either.
  defp split_set_passwd(param, nick) do
    case String.split(param, " ", parts: 2) do
      # The head is the OLD password; grappa cannot vet it, services do.
      [_, new_password] ->
        case vet_new_password(:set_passwd, new_password, nick) do
          :ok -> {:capture, :set_passwd, new_password}
          reject -> reject
        end

      [_] ->
        {:reject, :set_passwd, :syntax_error}
    end
  end

  # The guard chain BOTH rotation handlers apply to a new password, in THEIR
  # order — same order so the reason we report is the notice the user
  # actually receives. `do_set_password` (`:2210`-`:2226`) and `do_resetpass`
  # (`:3917`-`:3934`) run the identical four checks against the identical
  # constants; only the nick they compare against differs, so the caller
  # supplies it (`callerUser->nick` for SET PASSWD, the nick being RESET for
  # RESETPASS). One chain, because a second copy would drift from the first
  # the next time Azzurra adds a rule.
  #
  # The spaces arm cannot fire on the RESETPASS path: `strtok(" ")` ends the
  # token at the first space, so its third token can never hold one — which
  # is also why `do_resetpass`'s own `strchr(newpass, ' ')` (`:3917`) is dead
  # code upstream. Shared and unreachable beats duplicated and divergent.
  @spec vet_new_password(rotation_kind(), String.t(), String.t()) ::
          :ok | {:reject, rotation_kind(), vet_reject_reason()}
  defp vet_new_password(kind, new_password, nick) do
    case vet_password(new_password, nick) do
      :ok -> :ok
      {:error, reason} -> {:reject, kind, reason}
    end
  end

  @doc """
  The guard chain on its own, without a wire verb attached — `:ok`, or
  `{:error, reason}` naming the services error the value would earn.

  #124 gave the NickServ password a SECOND door: an operator can now type it
  straight into the per-network password field instead of rotating it through
  a `SET PASSWD` on the wire. Both doors write the SAME credential column, so
  both must refuse the same values — a field that accepts what services will
  refuse just stores a password that silently never identifies, which is the
  split brain #124 exists to end.

  Public for that second caller (`Grappa.Networks.Credentials`). It is the
  SAME chain `vet_new_password/3` runs, deliberately not a copy: a second copy
  would drift from the first the next time Azzurra adds a rule, and then the
  two doors would disagree about the same secret.
  """
  @spec vet_password(String.t(), String.t()) :: :ok | {:error, vet_reject_reason()}
  def vet_password(new_password, nick) when is_binary(new_password) and is_binary(nick) do
    cond do
      String.contains?(new_password, " ") -> {:error, :password_with_spaces}
      insecure?(new_password, nick) -> {:error, :insecure_password}
      byte_size(new_password) > @passmax -> {:error, :password_max_length}
      ccodes?(new_password) -> {:error, :password_with_ccodes}
      true -> :ok
    end
  end

  # `str_equals_nocase(<nick>, newpass) || (str_len(newpass) < 5)` — the nick
  # being `callerUser->nick` in `do_set_password` and `ni->nick` (the reset
  # target, up to case: `findnick` matches case-insensitively) in
  # `do_resetpass`. `str_len` is a BYTE count, and the case-insensitive
  # compare is the plain ASCII one — `Identifier.canonical_target/1`, per the
  # project-wide rule that no nick comparison uses a bare `String.downcase/1`.
  defp insecure?(new_password, nick) do
    byte_size(new_password) < @passmin or
      Identifier.canonical_target(new_password) == Identifier.canonical_target(nick)
  end

  # `string_has_ccodes` (`src/misc.c:1321`): any BYTE below 32, or the byte
  # 160. Byte-level on purpose — 160 is a UTF-8 continuation byte (`à` is
  # `C3 A0`), so services refuse accented passwords too, and mirroring them
  # per-byte is the only way to predict that.
  defp ccodes?(password) do
    password |> :binary.bin_to_list() |> Enum.any?(&(&1 < 32 or &1 == 160))
  end

  defp intercept_bare(line) do
    case Regex.run(@bare_re, line, capture: :all_but_first) do
      [verb, rest] -> dispatch(String.upcase(verb), rest)
      nil -> intercept_pass(line)
    end
  end

  defp intercept_pass(line) do
    case Regex.run(@pass_re, line, capture: :all_but_first) do
      [rest] -> {:capture, :identify, identify_password(rest)}
      nil -> :passthrough
    end
  end

  # REGISTER takes the password first and earns `+r` later, via the auth code,
  # so it has its own `:register` kind (#129). GHOST names a nick before its
  # password, and with the nick alone carries none (issue 2318). The rest of
  # the identify family is `identify_password/1`.
  defp dispatch("REGISTER", rest), do: {:capture, :register, first_token(rest)}
  defp dispatch("GHOST", rest), do: ghost_password(rest)
  defp dispatch(_, rest), do: {:capture, :identify, identify_password(rest)}

  # `do_identify` (`src/nickserv.c:1669`): two `strtok(NULL, " ")`. With one
  # token that token is the password and the account is the caller's nick;
  # with two, the SECOND is the password; a third is never read. Every door
  # reaches that same pair — the ircd hands `IDENTIFY`, `NS` and `NICKSERV`
  # one parameter, so the rest of the line arrives whole (bahamut
  # `include/msg.h`), and `m_pass` forwards `parv[1] parv[2]` and drops the
  # rest. Taking the LAST token instead (issue 2318) read whatever followed
  # the password as the password.
  defp identify_password(rest) do
    case String.split(rest) do
      [password] -> password
      [_account, password | _] -> password
    end
  end

  # `do_ghost` (`src/nickserv.c:3439`) requires `<nick> <pass>` and answers a
  # lone nick with NS_GHOST_SYNTAX_ERROR; Atheme accepts the lone nick from
  # an identified caller (`GHOST <target> [password]`). Neither puts a
  # password on that line, and capturing the nick staged it as one — the next
  # `+r` inside the window then committed a `Guest<N>` over the real secret.
  defp ghost_password(rest) do
    case String.split(rest) do
      [_nick] -> :passthrough
      [_nick, password | _] -> {:capture, :identify, password}
    end
  end

  defp first_token(rest), do: rest |> String.split() |> List.first()
end
