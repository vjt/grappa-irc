defmodule Grappa.Dcc.Policy do
  @moduledoc """
  Whether a peer's `DCC SEND` offer may be held, and whether an accepted
  one may be dialled (issue 2089).

  Every check here happens BEFORE a socket is opened. That is the whole
  reason this module is not inside `Grappa.Dcc.Transfer`: the transport is
  deliberately dumb so that each refusal keeps its OWN reported reason —
  2089's hardest rule is that no outcome is silent, and a transport that
  also judged would have collapsed several distinct refusals into one
  `{:error, :refused}`. Keeping the gate out also keeps the transport
  honestly testable against real loopback sockets, which an SSRF gate
  would refuse; that is a consequence of the split, not its reason.

  ## Two phases, because the questions are asked at different moments

  `admit_offer/1` runs when the offer ARRIVES, before it is held and
  before the operator is prompted. It asks only what is knowable from the
  offer itself — is this an address we may dial, is the claimed size under
  our ceiling — so a stranger's unroutable or oversized offer is refused
  and REPORTED immediately, rather than sitting in the held set as a
  consent prompt for something we would never honour.

  `admit_accept/1` runs when the operator says yes, before the dial. It
  asks the questions whose answers depend on US and on WHEN: the per-day
  quota (which must be consumed by an ACCEPT and never by an offer, or a
  flood of offers nobody answered would exhaust a subject's allowance) and
  the spool's disk budget (which other transfers move between the offer
  and the accept).

  ## Three axes, deliberately not one

  Size, address class and rate are independent properties, and each has
  its own sentence in `Grappa.Dcc.Report`. Folding them into a single
  boolean would tell the operator a file "was refused" without telling
  them whether to ask the sender for a smaller one, to stop asking at all,
  or to try again tomorrow.
  """

  use Boundary,
    top_level?: true,
    # `Grappa.RateLimit` whole, not the `DailyQuota` leaf: the leaf is not
    # a boundary of its own (measured — the compiler answers "unknown
    # boundary"), and promoting it would be a change to a shared module
    # for one consumer's tidiness. `Grappa.Themes` declares it the same
    # way for the same quota.
    deps: [Grappa.Dcc, Grappa.IRC, Grappa.Net.Ssrf, Grappa.RateLimit, Grappa.Subject]

  alias Grappa.{Dcc, Subject}
  alias Grappa.IRC.DCC.Offer
  alias Grappa.Net.Ssrf
  alias Grappa.RateLimit.DailyQuota

  @quota_bucket :dcc_receive

  # How many DCC transfers one subject may accept per calendar day. OURS,
  # not ruled — vjt gave no number here either. Ten is a day's worth of
  # deliberate, individually-consented accepts: every one of them costs a
  # human a click, so a legitimate user cannot plausibly reach it, while a
  # social-engineered operator clicking yes on everything is stopped at ten
  # rather than at the disk budget. Sits ALONGSIDE the byte caps rather
  # than replacing them: bytes bound the damage of one accept, this bounds
  # how many times the same subject can be talked into one.
  @daily_accepts 10

  @typedoc """
  Why an offer was not admitted. Distinct atoms, one per axis, because
  each earns its own sentence — see the moduledoc.
  """
  @type refusal :: :ssrf_blocked | :too_large | :rate_limited | :insufficient_storage

  @doc """
  Whether an arriving offer may be HELD and shown to the operator.

  Refuses an address we may not dial and a claim over the per-transfer
  ceiling. Says nothing about quota or disk — those belong to the accept,
  see the moduledoc.
  """
  @spec admit_offer(Offer.t()) :: :ok | {:error, :ssrf_blocked | :too_large}
  def admit_offer(%Offer{} = offer) do
    with :ok <- check_address(offer.ip) do
      check_size(offer.size)
    end
  end

  @doc """
  Whether `subject` may accept an offer right now — quota, then disk.

  ⚠️ **Consumes the quota slot on success.** `DailyQuota.check_and_record/3`
  is check-and-record in one atomic call, so this must be invoked once per
  accept and never speculatively: calling it to ask "could they?" spends
  the answer.

  Quota is tested BEFORE storage on purpose. Both refuse, but the quota is
  a property of this subject's own behaviour and the budget is a property
  of the deployment; reporting "you have accepted ten today" is actionable
  where "the server is full" is not, so when both are true the one the
  operator can do something about wins.
  """
  @spec admit_accept(Subject.t()) :: :ok | {:error, :rate_limited | :insufficient_storage}
  def admit_accept(subject) do
    with :ok <- DailyQuota.check_and_record(@quota_bucket, subject, @daily_accepts) do
      check_budget()
    end
  end

  @doc """
  The per-subject daily accept allowance. Public so a test and the report
  read the number instead of restating it.
  """
  @spec daily_accepts() :: unquote(@daily_accepts)
  def daily_accepts, do: @daily_accepts

  # `Grappa.IRC.DCC.parse/1` already decoded the address into an `:inet`
  # tuple and refused a hostname outright, so there is no name to resolve
  # here and no DNS-rebind window to worry about — the tuple this judges
  # is the tuple `Transfer` dials. That is why the check is
  # `safe_public_ip?/1` and not `resolve_safe/1`.
  defp check_address(ip) do
    if Ssrf.safe_public_ip?(ip), do: :ok, else: {:error, :ssrf_blocked}
  end

  # Against the CLAIM, before any socket exists — which is the point: an
  # oversized offer costs us nothing, not even a connect. The claim is not
  # trusted afterwards either; `Transfer` truncates the drained stream at
  # exactly this many bytes, so declaring low to slip under the ceiling
  # buys the sender a truncated file rather than a bypass.
  defp check_size(size) do
    if size <= Dcc.max_transfer_bytes(), do: :ok, else: {:error, :too_large}
  end

  defp check_budget do
    if Dcc.budget_available?(), do: :ok, else: {:error, :insufficient_storage}
  end
end
