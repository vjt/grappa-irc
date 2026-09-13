defmodule Grappa.Session.DccOffersTest do
  @moduledoc """
  Tests for `Grappa.Session.DccOffers` — the per-session set of DCC SEND
  offers held awaiting the operator's consent (issue 2089).

  CRITICAL invariants asserted here:

    * An offer is held under an opaque MINTED handle, never under
      anything the peer supplied. Two identical offers from the same
      peer are two distinct held offers.
    * The wire projection is the SAME expression on both paths — the
      event-time single (`to_wire/3`) and the cold-subscribe backfill
      (`held_offers/2`) — so a reload cannot render a banner that
      differs from the one the live event drew (the CP15 B7 property
      `WindowState` holds for `:invited`).
    * The filename on the wire is the NEUTRALISED one
      (`Grappa.Dcc.Report.display_filename/1`), so the banner and the
      scrollback row that follows it name the same file identically.
    * `channel` is carried verbatim, `$server` included: an offer from a
      stranger routes where `EventRouter.ctcp_query_channel/3` says it
      does, and this module does not coin a window for it (#546).
    * The held set has a ceiling and refuses NEW arrivals at it, so a
      flood cannot displace the offer the operator was about to accept.
    * Dropping an offer that is not held is `{:error, :not_held}`, never
      a silent no-op — the accept/refuse doors are REST doors, and a
      handle that names nothing is a 404, not a success.
  """

  use ExUnit.Case, async: true

  alias Grappa.Dcc.Report
  alias Grappa.IRC.DCC.Offer
  alias Grappa.Session.{DccOffers, Wire}

  @slug "azzurra"
  @channel "#grappa"
  @from "stranger"

  describe "hold/4" do
    test "mints a distinct opaque handle per offer, so two identical offers are two offers" do
      {:ok, first, one} = DccOffers.hold(DccOffers.new(), offer(), @from, @channel)
      {:ok, second, two} = DccOffers.hold(one, offer(), @from, @channel)

      refute first == second
      assert {:ok, _} = DccOffers.to_wire(two, @slug, first)
      assert {:ok, _} = DccOffers.to_wire(two, @slug, second)
      assert length(DccOffers.held_offers(two, @slug)) == 2
    end

    test "refuses a NEW offer once the ceiling is reached, keeping the ones already held" do
      {held_ids, full} = fill_to_cap()

      assert {:error, :too_many_offers} = DccOffers.hold(full, offer(), @from, @channel)
      assert length(DccOffers.held_offers(full, @slug)) == DccOffers.held_cap()

      for id <- held_ids do
        assert {:ok, _} = DccOffers.to_wire(full, @slug, id)
      end
    end

    test "the ceiling is a concurrency limit, not a lifetime budget — a drop frees a slot" do
      {[first | _], full} = fill_to_cap()
      {:ok, _, freed} = DccOffers.drop(full, first)

      assert {:ok, fresh, refilled} = DccOffers.hold(freed, offer(), @from, @channel)
      assert {:ok, _} = DccOffers.to_wire(refilled, @slug, fresh)
      assert length(DccOffers.held_offers(refilled, @slug)) == DccOffers.held_cap()
    end
  end

  describe "to_wire/3" do
    test "projects through the same Wire verb the live broadcast uses" do
      offer = offer()
      {:ok, id, held} = DccOffers.hold(DccOffers.new(), offer, @from, @channel)

      assert {:ok, payload} = DccOffers.to_wire(held, @slug, id)

      assert payload ==
               Wire.dcc_offer(
                 @slug,
                 @channel,
                 id,
                 @from,
                 Report.display_filename(offer.filename),
                 offer.size
               )
    end

    test "carries the NEUTRALISED filename, not the peer's raw bytes" do
      raw = "holi\x03day\x01.jpg"
      {:ok, id, held} = DccOffers.hold(DccOffers.new(), named(raw), @from, @channel)

      assert {:ok, %{filename: filename}} = DccOffers.to_wire(held, @slug, id)

      assert filename == Report.display_filename(raw)
      refute filename == raw
    end

    test "carries the routing channel verbatim, $server included" do
      {:ok, id, held} = DccOffers.hold(DccOffers.new(), offer(), @from, "$server")

      assert {:ok, %{channel: "$server"}} = DccOffers.to_wire(held, @slug, id)
    end

    test "an unheld handle is not tracked" do
      assert {:error, :not_held} = DccOffers.to_wire(DccOffers.new(), @slug, "nosuchoffer")
    end
  end

  describe "held_offers/2" do
    test "an empty set backfills nothing" do
      assert DccOffers.held_offers(DccOffers.new(), @slug) == []
    end

    test "backfills exactly what the live events carried, for every held offer" do
      {:ok, first, one} = DccOffers.hold(DccOffers.new(), offer(), @from, @channel)
      {:ok, second, two} = DccOffers.hold(one, offer(), "someone_else", "$server")

      {:ok, first_payload} = DccOffers.to_wire(two, @slug, first)
      {:ok, second_payload} = DccOffers.to_wire(two, @slug, second)

      assert MapSet.new(DccOffers.held_offers(two, @slug)) ==
               MapSet.new([first_payload, second_payload])
    end
  end

  describe "drop/2" do
    test "hands back what the caller needs to act on the offer, and stops holding it" do
      offer = offer()
      {:ok, id, held} = DccOffers.hold(DccOffers.new(), offer, @from, @channel)

      assert {:ok, entry, dropped} = DccOffers.drop(held, id)

      assert entry.offer == offer
      assert entry.from == @from
      assert entry.channel == @channel
      assert {:error, :not_held} = DccOffers.to_wire(dropped, @slug, id)
      assert DccOffers.held_offers(dropped, @slug) == []
    end

    test "is not idempotent — the second drop says the handle names nothing" do
      {:ok, id, held} = DccOffers.hold(DccOffers.new(), offer(), @from, @channel)
      {:ok, _, dropped} = DccOffers.drop(held, id)

      assert {:error, :not_held} = DccOffers.drop(dropped, id)
    end

    test "an unknown handle is refused, never swallowed" do
      assert {:error, :not_held} = DccOffers.drop(DccOffers.new(), "nosuchoffer")
    end

    test "drops only the named offer" do
      {:ok, first, one} = DccOffers.hold(DccOffers.new(), offer(), @from, @channel)
      {:ok, second, two} = DccOffers.hold(one, offer(), @from, @channel)
      {:ok, _, remaining} = DccOffers.drop(two, first)

      assert {:error, :not_held} = DccOffers.to_wire(remaining, @slug, first)
      assert {:ok, _} = DccOffers.to_wire(remaining, @slug, second)
    end
  end

  describe "hold_ms/0" do
    test "is the hold window every armed expiry uses, in milliseconds" do
      assert is_integer(DccOffers.hold_ms())
      assert DccOffers.hold_ms() > 0
    end
  end

  defp offer, do: named("holiday.jpg")

  defp named(filename),
    do: %Offer{filename: filename, ip: {1, 2, 3, 4}, port: 5000, size: 12_345}

  defp fill_to_cap do
    Enum.map_reduce(1..DccOffers.held_cap(), DccOffers.new(), fn _, acc ->
      {:ok, id, next} = DccOffers.hold(acc, offer(), @from, @channel)
      {id, next}
    end)
  end
end
