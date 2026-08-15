defmodule Grappa.IRC.JoinFailureTest do
  @moduledoc """
  #1345 — the truncation gate for the join-failure numeric set.

  The expected list below is written out by hand, from the ircd sources
  cited in `Grappa.IRC.JoinFailure`'s moduledoc, and is deliberately NOT
  derived from `numerics/0`: a test that asks the production list to
  confirm itself passes vacuously through exactly the truncation that made
  a `+R` channel hang at `:pending` forever.

  Everything else that consumes the set (both `EventRouter` guards, the
  `NumericRouter` correlation gate) derives from `numerics/0`, so this is
  the one place where a dropped code becomes a red test.
  """
  use ExUnit.Case, async: true

  alias Grappa.IRC.JoinFailure

  # azzurra/bahamut @ 5c41c8b + solanum @ 2ce64de. One line per code, so a
  # deletion is a visible deletion in review, not a shortened literal.
  @measured [
    # 403 ERR_NOSUCHCHANNEL — bahamut channel.c:2221, solanum m_join.c:213
    403,
    # 405 ERR_TOOMANYCHANNELS — bahamut channel.c:2354, solanum m_join.c:317
    405,
    # 437 ERR_UNAVAILRESOURCE — solanum m_join.c:242/303/328 (channel form)
    437,
    # 471 ERR_CHANNELISFULL (+l) — both, can_join
    471,
    # 473 ERR_INVITEONLYCHAN (+i) — both, can_join
    473,
    # 474 ERR_BANNEDFROMCHAN (+b) — both, can_join
    474,
    # 475 ERR_BADCHANNELKEY (+k) — both, can_join
    475,
    # 476 ERR_ONLYSSLCLIENTS — bahamut channel.c:1973
    476,
    # 477 ERR_NEEDREGGEDNICK (+R/+r) — both, can_join
    477,
    # 479 ERR_BADCHANNAME — solanum m_join.c:198/221
    479,
    # 480 ERR_THROTTLE (+j) — solanum channel.c:785
    480,
    # 485 ERR_CHANBANREASON (quarantined channel) — bahamut channel.c:2313
    485
  ]

  describe "numerics/0" do
    test "is exactly the measured set — a dropped code is the #1345 bug" do
      assert JoinFailure.numerics() == @measured
    end

    test "carries the two codes whose absence was #1345 (476, 477)" do
      assert 477 in JoinFailure.numerics()
      assert 476 in JoinFailure.numerics()
    end

    test "excludes the numerics that carry no correlatable channel" do
      # 481 ERR_NOPRIVILEGES has no channel param (bahamut s_err.c:550),
      # 443 ERR_USERONCHANNEL carries it at params[2], 470 ERR_LINKCHANNEL
      # is a redirect. Including any of them would either misread the
      # reason slot or swallow an unrelated error. See the moduledoc.
      refute 481 in JoinFailure.numerics()
      refute 443 in JoinFailure.numerics()
      refute 470 in JoinFailure.numerics()
    end

    test "is ascending and duplicate-free" do
      numerics = JoinFailure.numerics()

      assert numerics == Enum.sort(numerics)
      assert numerics == Enum.uniq(numerics)
    end
  end
end
