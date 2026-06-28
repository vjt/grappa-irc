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
  the DB; a rejected SET PASSWD is recovered by #124's re-auth backstop.

  Covers the full azzurra identify-channel set (source-verified against
  `bahamut-azzurra` ircd + azzurra `services`):

    * `PRIVMSG NickServ[@host] :IDENTIFY|ID|SIDENTIFY|GHOST|REGISTER <args>`
    * `NS|NICKSERV IDENTIFY|ID|SIDENTIFY|GHOST|REGISTER <args>`   (services command alias)
    * `IDENTIFY|ID|SIDENTIFY <args>`                    (ircd `m_identify`)
    * `PASS <args>`                                     (ircd `m_pass` -> `m_identify`, post-connect)
    * `PRIVMSG NickServ[@host] :SET PASSWD <new>` / `NS|NICKSERV SET PASSWD <new>` /
      bare `SET PASSWD <new>`                           (#131 — in-session password change)

  Every pattern is ANCHORED at line start (`^`) so a channel PRIVMSG body that
  merely CONTAINS "identify"/"pass"/"set passwd" is never captured — raw IRC
  frames start with the command verb, PRIVMSGs start with `PRIVMSG`.

  Password extraction: last whitespace token for IDENTIFY/ID/SIDENTIFY/GHOST/
  PASS (`IDENTIFY [account] <pass>`, `GHOST <nick> <pass>`, `PASS [nick] <pass>`);
  FIRST token for REGISTER (`REGISTER <pass> <email>`); REST-OF-LINE for
  SET PASSWD (Azzurra parses the new password with `strtok(NULL,"")`, so it
  may contain spaces — never split on the first space). The Azzurra verb is
  `SET PASSWD`, NOT `SET PASSWORD` (`do_set` only routes `PASSWD`; `PASSWORD`
  errors), so the regex matches `PASSWD` exactly and lets `SET PASSWORD …`
  fall through untouched.

  Boundary: inherits the parent `Grappa.Session` boundary (no `use Boundary`).
  """

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
  rendezvous. The host maps verb → action; the interceptor only reports
  which verb it saw.
  """
  @type kind :: :identify | :register | :set_passwd

  @type result :: :passthrough | {:capture, kind(), String.t()}

  # PRIVMSG-to-NickServ / NS-NICKSERV command form. `(?:...)` groups are
  # non-capturing; capture groups are (verb, rest).
  @verb_re ~r/^(?:PRIVMSG\s+NickServ(?:@\S+)?\s+:|(?:NS|NICKSERV)\s+)(IDENTIFY|ID|SIDENTIFY|GHOST|REGISTER)\s+(\S.*?)\s*$/i

  # Bare ircd command form (m_identify).
  @bare_re ~r/^(IDENTIFY|ID|SIDENTIFY)\s+(\S.*?)\s*$/i

  # PASS post-connect identify (m_pass -> m_identify).
  @pass_re ~r/^PASS\s+(\S.*?)\s*$/i

  # #131 — in-session SET PASSWD. Same anchored PRIVMSG-NickServ / NS-NICKSERV
  # prefix family as `@verb_re`, plus the bare form (raw `/quote SET PASSWD`),
  # via an optional prefix group. The verb is the literal two-token `SET
  # PASSWD` (Azzurra `do_set` only routes `PASSWD`; `PASSWORD` errors — the
  # literal `PASSWD\s+` naturally rejects `PASSWORD …`). The single capture
  # group is the new password: REST-OF-LINE, leading/trailing whitespace
  # trimmed, internal spaces preserved (Azzurra parses it with
  # `strtok(NULL,"")`).
  @set_passwd_re ~r/^(?:PRIVMSG\s+NickServ(?:@\S+)?\s+:|(?:NS|NICKSERV)\s+)?SET\s+PASSWD\s+(\S.*?)\s*$/i

  @doc """
  Inspects one outbound IRC wire line and returns either `:passthrough`
  (no NickServ secret-bearing verb detected) or `{:capture, kind, password}`
  with the cleartext password lifted out and the verb class (`:identify` /
  `:register` / `:set_passwd`) for the host to act on.

  Pure: no side effects. The host (`Grappa.Session.Server`) decides whether
  to stage against `+r` MODE (`:identify`/`:register`), commit optimistically
  on-send (`:set_passwd`, #131), discard on the pending-auth timeout, or
  overwrite on a subsequent capture.
  """
  @spec intercept(String.t()) :: result()
  def intercept(line) when is_binary(line) do
    case Regex.run(@verb_re, line, capture: :all_but_first) do
      [verb, rest] -> dispatch(String.upcase(verb), rest)
      nil -> intercept_set_passwd(line)
    end
  end

  # #131 — SET PASSWD. The whole captured group IS the new password
  # (rest-of-line), so there's no token-splitting clause: spaces are
  # legal. SET PASSWD shares no verb with the identify family, so this
  # check is order-independent w.r.t. `@verb_re`/`@bare_re`/`@pass_re`.
  defp intercept_set_passwd(line) do
    case Regex.run(@set_passwd_re, line, capture: :all_but_first) do
      [new_password] -> {:capture, :set_passwd, new_password}
      nil -> intercept_bare(line)
    end
  end

  defp intercept_bare(line) do
    case Regex.run(@bare_re, line, capture: :all_but_first) do
      [verb, rest] -> dispatch(String.upcase(verb), rest)
      nil -> intercept_pass(line)
    end
  end

  defp intercept_pass(line) do
    case Regex.run(@pass_re, line, capture: :all_but_first) do
      [rest] -> {:capture, :identify, last_token(rest)}
      nil -> :passthrough
    end
  end

  # Catch-all: IDENTIFY / ID / SIDENTIFY / GHOST all take the password as
  # the last token AND grant +r synchronously → `:identify`. Only REGISTER
  # (password first, +r granted later via the auth-code) needs its own
  # clause AND its own `:register` kind (#129).
  defp dispatch("REGISTER", rest), do: {:capture, :register, first_token(rest)}
  defp dispatch(_, rest), do: {:capture, :identify, last_token(rest)}

  defp last_token(rest), do: rest |> String.split() |> List.last()
  defp first_token(rest), do: rest |> String.split() |> List.first()
end
